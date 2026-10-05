import { describe, expect, it } from "vitest";
import {
  AgentPromptCompiler,
  createDefaultAgentBehavior,
  type AgentToolName,
} from "../../src/modules/agents/index.js";

const publicTools: AgentToolName[] = [
  "get_service_information",
  "list_customer_appointments",
  "check_availability",
  "create_appointment",
  "update_customer",
  "cancel_appointment",
  "reschedule_appointment",
  "transfer_to_human",
];

describe("AgentPromptCompiler", () => {
  it("describes every public capability and keeps backend results authoritative", () => {
    const prompt = new AgentPromptCompiler().compile({
      editableInstructions: "Sé amable.",
      locale: "es-MX",
      businessName: "YIBO Dental",
      locationName: "Centro",
      locationTimezone: "America/Mexico_City",
      enabledTools: publicTools,
      confirmationRequiredFor: ["create_appointment", "cancel_appointment"],
      behavior: createDefaultAgentBehavior("es-MX"),
    });

    for (const tool of publicTools) expect(prompt).toContain(tool);
    expect(prompt).toContain("descriptions, prices, and branch availability");
    expect(prompt).toContain("Speak only each slot's displayStart or localStartAt");
    expect(prompt).toContain("read it back using the configured phoneReadback style");
    expect(prompt).toContain("Read in natural groups with pauses");
    expect(prompt).not.toContain("Repeat the phone number digit by digit");
    expect(prompt).toContain("neutral Mexican accent");
    expect(prompt).toContain("Do not use an English-speaking accent");
    expect(prompt).toContain("name the professional");
    expect(prompt).toContain("invoke end_call");
    expect(prompt).toContain("same-call appointmentReference");
    expect(prompt).toContain("backend owns the destination");
    expect(prompt).toContain("Backend confirmation is required for: create_appointment, cancel_appointment");
    expect(prompt).toContain("Retry only after a new caller turn, with identical action arguments and that token");
    expect(prompt).toContain("Never claim a mutation succeeded until its tool returns success");
    expect(prompt).toContain('Location timezone: "America/Mexico_City"');
    expect(prompt).toContain("Tool timestamps ending in Z are UTC: convert them before speaking");
    expect(prompt).toContain("copying their original values unchanged into later tool calls");
  });

  it("does not advertise authority for disabled capabilities", () => {
    const prompt = new AgentPromptCompiler().compile({
      editableInstructions: "Be concise.",
      locale: "en-US",
      businessName: "YIBO Dental",
      locationName: "Downtown",
      locationTimezone: "America/Chicago",
      enabledTools: [],
      confirmationRequiredFor: [],
      behavior: createDefaultAgentBehavior("en-US"),
    });

    expect(prompt).toContain("No tools are enabled");
    expect(prompt).toContain("Do not claim that you can create appointments");
    expect(prompt).toContain("Do not claim that you can transfer the call");
    expect(prompt).toContain("No additional backend confirmation gate is active");
  });
});
