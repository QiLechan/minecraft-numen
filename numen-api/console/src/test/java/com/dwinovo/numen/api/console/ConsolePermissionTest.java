package com.dwinovo.numen.api.console;

import com.dwinovo.numen.api.permission.Mode;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;

import static org.junit.jupiter.api.Assertions.*;

class ConsolePermissionTest {
    @Test void permissionCannotBeGrantedAfterCancellationOrExpiration() {
        var replies = new ArrayList<String>();
        var permission = new ConsolePermission(Mode.ASK, (id, allow) -> replies.add(id + ":" + allow), ignored -> {});
        var action = JsonParser.parseString("{\"kind\":\"break\",\"target\":{\"block\":\"stone\"}}").getAsJsonObject();
        permission.request("1", action);
        assertTrue(replies.isEmpty());
        permission.cancel();
        assertFalse(permission.answer("1", true));
        permission.request("2", action);
        assertTrue(permission.answer("2", false));
        assertFalse(permission.answer("2", true));
        assertEquals(java.util.List.of("1:false", "2:false"), replies);
    }

    @Test void observeDeniesAndBypassAllowsPendingActions() {
        var replies = new ArrayList<Boolean>();
        var permission = new ConsolePermission(Mode.OBSERVE, (id, allow) -> replies.add(allow), ignored -> {});
        var action = JsonParser.parseString("{\"kind\":\"command\",\"target\":{\"line\":\"/op bot\"}}").getAsJsonObject();
        permission.request("1", action);
        permission.mode(Mode.ASK);
        permission.request("2", action);
        permission.mode(Mode.BYPASS);
        permission.request("3", action);
        assertEquals(java.util.List.of(false, true, true), replies);
        assertFalse(permission.answer("2", true));
    }
}
