package com.dwinovo.numen.api.console;

import com.dwinovo.numen.api.permission.Mode;
import com.google.gson.JsonObject;

import java.util.LinkedHashSet;
import java.util.Set;
import java.util.function.BiConsumer;
import java.util.function.Consumer;

/** 普通客户端看不到服务器的归属记录,ASK 对每个世界动作询问,不猜服务端的权限信号。 */
final class ConsolePermission {
    private static final Set<String> ACTIONS = Set.of("break", "place", "attack", "use_block", "use_entity", "take", "deposit", "drop", "command", "consume", "craft");
    private Mode mode;
    private final Set<String> pending = new LinkedHashSet<>();
    private final BiConsumer<String, Boolean> reply;
    private final Consumer<String> show;

    ConsolePermission(Mode mode, BiConsumer<String, Boolean> reply, Consumer<String> show) {
        this.mode = mode;
        this.reply = reply;
        this.show = show;
    }

    void request(String id, JsonObject action) {
        if (!ACTIONS.contains(action.get("kind").getAsString())) throw new IllegalArgumentException("Unknown body action: " + action);
        switch (mode) {
            case BYPASS -> reply.accept(id, true);
            case OBSERVE -> reply.accept(id, false);
            case ASK -> {
                pending.add(id);
                show.accept("Permission " + id + ": " + action + "\n/approve " + id + " or /deny " + id + " (expires in 90s)");
            }
        }
    }

    boolean answer(String id, boolean allow) {
        if (!pending.remove(id)) return false;
        reply.accept(id, allow);
        return true;
    }

    void cancel() {
        for (String id : Set.copyOf(pending)) answer(id, false);
    }

    void mode(Mode next) {
        mode = next;
        if (next != Mode.ASK) for (String id : Set.copyOf(pending)) answer(id, next == Mode.BYPASS);
    }

    Mode mode() { return mode; }
}
