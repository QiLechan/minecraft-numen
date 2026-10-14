package com.dwinovo.numen.api.console;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

class ConsoleIntegrationTest {
    @TempDir Path directory;

    @Test void consoleRunsTheExistingAgentThroughARealNetworkBodyAndPersistsToolResults() throws Exception {
        HttpServer model = HttpServer.create(new java.net.InetSocketAddress("127.0.0.1", 0), 0);
        var requests = new LinkedBlockingQueue<JsonObject>();
        var calls = new AtomicInteger();
        model.createContext("/v1/chat/completions", exchange -> {
            requests.add(JsonParser.parseString(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8)).getAsJsonObject());
            String delta = calls.getAndIncrement() == 0
                    ? """
                      {"tool_calls":[{"index":0,"id":"body-status-1","type":"function","function":{"name":"status","arguments":"{}"}}]}
                      """.strip()
                    : "{\"content\":\"network body confirmed\"}";
            String response = "data: {\"choices\":[{\"index\":0,\"delta\":" + delta + ",\"finish_reason\":null}]}\n\ndata: [DONE]\n\n";
            exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
            byte[] bytes = response.getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, bytes.length);
            exchange.getResponseBody().write(bytes);
            exchange.close();
        });
        model.start();
        Process server = new ProcessBuilder("node", System.getProperty("numen.test.server"), "1.21.1")
                .redirectError(ProcessBuilder.Redirect.INHERIT).start();
        Process client = null;
        try {
            String port = new BufferedReader(new InputStreamReader(server.getInputStream())).readLine();
            assertNotNull(port);
            Path config = directory.resolve("config.json");
            Files.writeString(config, """
                    {"host":"127.0.0.1","port":%s,"username":"Numen","auth":"offline","llm":{
                      "provider":"custom","model":"test-model","baseUrl":"http://127.0.0.1:%d/v1"}}
                    """.formatted(port, model.getAddress().getPort()));
            var builder = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin/java").toString(),
                    "-Dnumen.bridge=" + System.getProperty("numen.test.bridge"), "-cp", System.getProperty("numen.test.classpath"),
                    ConsoleMain.class.getName(), "--config", config.toString()).redirectError(ProcessBuilder.Redirect.INHERIT);
            builder.environment().put("NUMEN_API_KEY", "test-only");
            client = builder.start();
            var output = new LinkedBlockingQueue<String>();
            Process running = client;
            Thread.startVirtualThread(() -> {
                try (var reader = running.inputReader(StandardCharsets.UTF_8)) { reader.lines().forEach(output::add); }
                catch (java.io.IOException error) { output.add("Read failed: " + error.getMessage()); }
            });
            awaitLine(output, "Joined Minecraft");
            var input = client.outputWriter(StandardCharsets.UTF_8);
            input.write("请查看你的状态\n");
            input.flush();
            awaitLine(output, "Numen: network body confirmed");
            assertEquals(2, calls.get());
            JsonObject first = requests.poll(1, TimeUnit.SECONDS);
            assertNotNull(first);
            assertTrue(first.has("tools"));
            JsonObject second = requests.poll(1, TimeUnit.SECONDS);
            assertNotNull(second);
            JsonArray messages = second.getAsJsonArray("messages");
            JsonObject tool = java.util.stream.StreamSupport.stream(messages.spliterator(), false)
                    .map(value -> value.getAsJsonObject()).filter(value -> value.get("role").getAsString().equals("tool")).findFirst().orElseThrow();
            assertEquals("body-status-1", tool.get("tool_call_id").getAsString());
            assertTrue(tool.get("content").getAsString().contains("\"health\":20"));
            input.write("/stop\n/quit\n");
            input.flush();
            assertTrue(client.waitFor(10, TimeUnit.SECONDS));
            assertEquals(0, client.exitValue());
            Path state = directory.resolve("numen-console-state");
            try (var files = Files.walk(state)) {
                String history = Files.readString(files.filter(p -> p.getFileName().toString().equals("conversation.jsonl")).findFirst().orElseThrow());
                assertTrue(history.contains("body-status-1"));
                assertTrue(history.contains("network body confirmed"));
            }
        } finally {
            if (client != null) client.destroyForcibly();
            server.destroyForcibly();
            model.stop(0);
        }
    }

    private static void awaitLine(LinkedBlockingQueue<String> output, String expected) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15);
        var received = new StringBuilder();
        while (System.nanoTime() < deadline) {
            String line = output.poll(1, TimeUnit.SECONDS);
            if (line != null) {
                received.append(line).append('\n');
                if (line.contains(expected)) return;
            }
        }
        fail("Missing output " + expected + "\n" + received);
    }
}
