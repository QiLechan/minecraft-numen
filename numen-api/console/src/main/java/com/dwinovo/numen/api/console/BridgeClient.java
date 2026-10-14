package com.dwinovo.numen.api.console;

import com.dwinovo.numen.api.agent.llm.ToolOutcome;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.BufferedWriter;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import java.util.function.Consumer;

/** 网络身体的进程运输。回调全部交给宿主线程,不从读线程修改大脑。 */
final class BridgeClient implements AutoCloseable {
    private final Process process;
    private final BufferedWriter writer;
    private final Map<String, Consumer<String>> pending = new HashMap<>();
    private long lastId;
    private boolean disconnected;

    BridgeClient(Path script, Consumer<Runnable> dispatch, Consumer<JsonObject> receive, Consumer<String> ended) throws IOException {
        process = new ProcessBuilder("node", script.toString()).redirectError(ProcessBuilder.Redirect.INHERIT).start();
        writer = process.outputWriter(StandardCharsets.UTF_8);
        Thread.startVirtualThread(() -> {
            try (var reader = process.inputReader(StandardCharsets.UTF_8)) {
                String line;
                while ((line = reader.readLine()) != null) {
                    JsonObject message = JsonParser.parseString(line).getAsJsonObject();
                    dispatch.accept(() -> {
                        receive.accept(message);
                        if (message.get("kind").getAsString().equals("result")) {
                            Consumer<String> reply = pending.remove(message.get("id").getAsString());
                            if (reply != null) {
                                String result = message.get("success").getAsBoolean()
                                        ? message.get("data").toString()
                                        : ToolOutcome.failure(message.get("message").getAsString()
                                            + (message.has("state") ? "; actual body: " + message.get("state") : ""));
                                reply.accept(result);
                            }
                        }
                    });
                }
                int code = process.waitFor();
                dispatch.accept(() -> ended.accept("Network client exited (" + code + ")"));
            } catch (IOException | InterruptedException | RuntimeException error) {
                dispatch.accept(() -> ended.accept("Network transport failed: " + error.getMessage()));
            }
        });
    }

    void send(JsonObject message) {
        try {
            writer.write(message.toString());
            writer.newLine();
            writer.flush();
        } catch (IOException error) {
            throw new UncheckedIOException(error);
        }
    }

    void command(String kind) {
        JsonObject message = new JsonObject();
        message.addProperty("kind", kind);
        if (!disconnected) send(message);
    }

    void invoke(String name, JsonObject args, Consumer<String> done) {
        String id = Long.toString(++lastId);
        JsonObject message = new JsonObject();
        message.addProperty("kind", "call");
        message.addProperty("id", id);
        message.addProperty("name", name);
        message.add("args", args);
        pending.put(id, done);
        send(message);
    }

    void consent(String id, boolean allow) {
        JsonObject message = new JsonObject();
        message.addProperty("kind", "consent");
        message.addProperty("id", id);
        message.addProperty("allow", allow);
        if (!disconnected) send(message);
    }

    void disconnected() { disconnected = true; }

    @Override public void close() {
        process.destroy();
        process.onExit().orTimeout(3, java.util.concurrent.TimeUnit.SECONDS).exceptionally(error -> {
            process.destroyForcibly();
            return process;
        });
    }
}
