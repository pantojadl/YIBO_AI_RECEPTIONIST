import { describe, expect, it, vi } from "vitest";
import {
  ScriptedVoiceMediaGateway,
  type ConversationTransport,
} from "../../src/modules/voice/index.js";

const emptyAudio = async function* () {};

describe("ScriptedVoiceMediaGateway", () => {
  it("releases a completed test's media without releasing a replacement registration", async () => {
    const gateway = new ScriptedVoiceMediaGateway();
    const first: ConversationTransport = { inboundAudio: emptyAudio(), outboundAudio: { write: vi.fn() }, close: vi.fn() };
    const second = { ...first };
    const releaseFirst = gateway.register("test", first);
    const releaseSecond = gateway.register("test", second);
    releaseFirst();
    await expect(gateway.open("test")).resolves.toMatchObject({ ok: true, value: second });
    releaseSecond(); releaseSecond();
    await expect(gateway.open("test")).resolves.toMatchObject({ ok: false, error: { code: "MEDIA_NOT_AVAILABLE" } });
  });
  it("exposes registered call media without owning a conversation runtime", async () => {
    const gateway = new ScriptedVoiceMediaGateway();
    const transport: ConversationTransport = {
      inboundAudio: emptyAudio(),
      outboundAudio: { write: vi.fn() },
      close: vi.fn(),
    };
    gateway.register("call-1", transport);

    await expect(gateway.open("call-1")).resolves.toEqual({ ok: true, value: transport });
    expect(gateway.openedCallIds).toEqual(["call-1"]);
  });

  it("returns a media error for an unregistered call", async () => {
    const gateway = new ScriptedVoiceMediaGateway();

    await expect(gateway.open("missing")).resolves.toEqual({
      ok: false,
      error: {
        code: "MEDIA_NOT_AVAILABLE",
        message: "No media transport is registered for call missing",
      },
    });
  });
});
