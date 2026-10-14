package com.dwinovo.numen.api.console;

import com.dwinovo.numen.api.agent.catalog.Api;
import com.dwinovo.numen.api.agent.catalog.Catalog;
import com.dwinovo.numen.api.agent.llm.ConnectionProfile;
import com.dwinovo.numen.api.agent.llm.EndpointResolver;
import com.dwinovo.numen.api.agent.llm.LlmEndpoint;
import com.dwinovo.numen.api.permission.Mode;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Map;

record ConsoleConfig(String host, int port, String username, String auth, String version, String owner,
                     Path stateDirectory, Mode permission, LlmEndpoint endpoint) {
    static ConsoleConfig load(Path file, Map<String, String> env) throws IOException {
        JsonObject json = JsonParser.parseString(Files.readString(file)).getAsJsonObject();
        String host = required(json, "host");
        String username = required(json, "username");
        String auth = text(json, "auth", "microsoft");
        if (!auth.equals("microsoft") && !auth.equals("offline")) throw new IllegalArgumentException("auth must be microsoft or offline");
        int port = json.has("port") ? json.get("port").getAsInt() : 25565;
        if (port < 1 || port > 65535) throw new IllegalArgumentException("Invalid server port");
        if (auth.equals("offline") && !username.matches("[A-Za-z0-9_]{1,16}")) throw new IllegalArgumentException("Invalid offline username");
        JsonObject llm = json.getAsJsonObject("llm");
        if (llm == null) throw new IllegalArgumentException("llm configuration is required");
        required(llm, "model");
        String protocol = text(llm, "protocol", "chat");
        if (Api.byId(protocol) == null) throw new IllegalArgumentException("protocol must be chat, responses or anthropic");
        JsonObject profile = llm.deepCopy();
        profile.addProperty("protocol", protocol);
        profile.addProperty("provider", text(llm, "provider", "custom"));
        String keyEnv = text(llm, "apiKeyEnv", "NUMEN_API_KEY");
        String key = env.getOrDefault(keyEnv, "");
        if (key.isBlank()) throw new IllegalArgumentException("Missing API key environment variable: " + keyEnv);
        profile.addProperty("apiKey", key);
        LlmEndpoint endpoint = EndpointResolver.resolve(new Gson().fromJson(profile, ConnectionProfile.class), Catalog.bundled(), "");
        if (!endpoint.hasUrl()) throw new IllegalArgumentException("Set llm.baseUrl or a known llm.provider");
        Path state = file.toAbsolutePath().getParent().resolve(text(json, "stateDirectory", "numen-console-state")).normalize();
        return new ConsoleConfig(host, port, username, auth, text(json, "version", "auto"), text(json, "owner", ""),
                state, mode(text(json, "permission", "ask")), endpoint);
    }

    static Mode mode(String text) {
        for (Mode mode : Mode.values()) if (mode.name().equalsIgnoreCase(text)) return mode;
        throw new IllegalArgumentException("permission mode must be ask, bypass or observe");
    }

    Path sessionDirectory() {
        // 账号、服务器与主人不同就不是同一段记忆,避免把另一台服务器的坐标与待办带进来。
        try {
            byte[] scope = (host + ":" + port + "\n" + username + "\n" + owner).getBytes(StandardCharsets.UTF_8);
            return stateDirectory.resolve(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(scope)).substring(0, 16));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    JsonObject connection() {
        JsonObject value = new JsonObject();
        value.addProperty("kind", "init");
        value.addProperty("host", host);
        value.addProperty("port", port);
        value.addProperty("username", username);
        value.addProperty("auth", auth);
        value.addProperty("version", version);
        value.addProperty("profilesFolder", stateDirectory.resolve("auth").toString());
        return value;
    }

    private static String required(JsonObject object, String key) {
        String value = text(object, key, "");
        if (value.isBlank()) throw new IllegalArgumentException("Missing configuration: " + key);
        return value;
    }

    private static String text(JsonObject object, String key, String defaultValue) {
        return object.has(key) && !object.get(key).isJsonNull() ? object.get(key).getAsString().strip() : defaultValue;
    }
}
