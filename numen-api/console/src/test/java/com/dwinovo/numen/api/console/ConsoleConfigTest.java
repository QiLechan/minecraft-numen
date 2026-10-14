package com.dwinovo.numen.api.console;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class ConsoleConfigTest {
    @TempDir Path directory;

    private ConsoleConfig config(String host, String protocol, Map<String, String> env) throws Exception {
        Path file = directory.resolve("config.json");
        Files.writeString(file, """
                {"host":"%s","username":"Numen","auth":"offline", "llm":{
                  "provider":"custom","protocol":"%s","model":"local-model","baseUrl":"http://localhost:8080/v1",
                  "apiKeyEnv":"TEST_KEY"}}
                """.formatted(host, protocol));
        return ConsoleConfig.load(file, env);
    }

    @Test void serverMemoriesAreIsolatedAndPathsAreRelativeToTheConfig() throws Exception {
        var first = config("first.example", "chat", Map.of("TEST_KEY", "test"));
        var second = config("second.example", "chat", Map.of("TEST_KEY", "test"));
        assertNotEquals(first.sessionDirectory(), second.sessionDirectory());
        assertEquals(directory.resolve("numen-console-state"), first.stateDirectory());
        assertEquals("auto", first.version());
        assertEquals("test", first.endpoint().apiKey());
    }

    @Test void missingSecretAndUnknownProtocolFailBeforeConnecting() {
        assertThrows(IllegalArgumentException.class, () -> config("localhost", "chat", Map.of()));
        assertThrows(IllegalArgumentException.class, () -> config("localhost", "typo", Map.of("TEST_KEY", "test")));
    }
}
