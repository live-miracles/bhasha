export type ReadinessItemId =
  | "program_setup"
  | "streams"
  | "translator_assignments"
  | "qr_generated"
  | "realtime_configured"
  | "turn_configured"
  | "turn_analytics_tagging"
  | "realtime_smoke_tested"
  | "mobile_field_tested";

export type ReadinessStatus = "green" | "warning" | "blocker";

export interface ReadinessItem {
  id: ReadinessItemId;
  label: string;
  status: ReadinessStatus;
  detail: string;
  checkedAt?: string;
}

export interface ReadinessStreamInput {
  id: string;
  languageName: string;
  isActive: boolean;
}

export interface ReadinessTranslatorInput {
  assignments: Array<{ streamId: string }>;
}

export interface ReadinessRow {
  realtimeSmokeTestedAt: string | null;
  mobileFieldTestedAt: string | null;
}

export interface ReadinessInputs {
  programName: string;
  streams: ReadinessStreamInput[];
  translators: ReadinessTranslatorInput[];
  realtimeConfigured: boolean;
  turnConfigured: boolean;
  row: ReadinessRow | null;
}

export interface AdminReadinessResponse {
  programId: string;
  items: ReadinessItem[];
}

// Operator confirmations that the system cannot derive on its own. These are the
// only readiness items backed by the program_readiness_checks table.
export const CONFIRMABLE_READINESS_ITEMS: ReadinessItemId[] = [
  "realtime_smoke_tested",
  "mobile_field_tested"
];

export function isConfirmableReadinessItem(
  value: string
): value is "realtime_smoke_tested" | "mobile_field_tested" {
  return (
    value === "realtime_smoke_tested" || value === "mobile_field_tested"
  );
}

export function buildReadinessItems(inputs: ReadinessInputs): ReadinessItem[] {
  const activeStreams = inputs.streams.filter((stream) => stream.isActive);
  const assignedStreamIds = new Set(
    inputs.translators.flatMap((translator) =>
      translator.assignments.map((assignment) => assignment.streamId)
    )
  );

  const items: ReadinessItem[] = [];

  items.push({
    id: "program_setup",
    label: "Program setup",
    status: "green",
    detail: `Program "${inputs.programName}" details are configured.`
  });

  if (activeStreams.length === 0) {
    items.push({
      id: "streams",
      label: "Language streams",
      status: "blocker",
      detail: "No active language streams exist for this program."
    });
  } else {
    items.push({
      id: "streams",
      label: "Language streams",
      status: "green",
      detail: `${activeStreams.length} active language stream${
        activeStreams.length === 1 ? "" : "s"
      } configured.`
    });
  }

  if (activeStreams.length === 0) {
    items.push({
      id: "translator_assignments",
      label: "Translator assignments",
      status: "blocker",
      detail: "No active streams are available to assign translators to."
    });
  } else {
    const unassigned = activeStreams.filter(
      (stream) => !assignedStreamIds.has(stream.id)
    );
    if (unassigned.length > 0) {
      items.push({
        id: "translator_assignments",
        label: "Translator assignments",
        status: "blocker",
        detail: `${unassigned.length} active stream${
          unassigned.length === 1 ? "" : "s"
        } missing a translator assignment: ${unassigned
          .map((stream) => stream.languageName)
          .join(", ")}.`
      });
    } else {
      items.push({
        id: "translator_assignments",
        label: "Translator assignments",
        status: "green",
        detail: "Every active stream has a translator assigned."
      });
    }
  }

  items.push({
    id: "qr_generated",
    label: "Listener QR code",
    status: "green",
    detail: "Listener QR payload is always available from the program detail."
  });

  items.push({
    id: "realtime_configured",
    label: "Realtime SFU configured",
    status: inputs.realtimeConfigured ? "green" : "blocker",
    detail: inputs.realtimeConfigured
      ? "Cloudflare Realtime SFU credentials are configured."
      : "Cloudflare Realtime SFU credentials are not configured."
  });

  items.push({
    id: "turn_configured",
    label: "TURN credentials configured",
    status: inputs.turnConfigured ? "green" : "blocker",
    detail: inputs.turnConfigured
      ? "Cloudflare TURN credentials are configured for restrictive networks."
      : "Cloudflare TURN is not configured; listeners on restrictive networks may fail to connect."
  });

  items.push({
    id: "turn_analytics_tagging",
    label: "TURN analytics tagging",
    status: "warning",
    detail:
      "TURN usage analytics tagging is not enabled because Slice 10 uses generate-ice-servers without custom identifiers."
  });

  const smokeAt = inputs.row?.realtimeSmokeTestedAt ?? null;
  items.push({
    id: "realtime_smoke_tested",
    label: "Realtime smoke tested",
    status: smokeAt ? "green" : "blocker",
    detail: smokeAt
      ? "Operator confirmed a realtime smoke test."
      : "No realtime smoke test has been confirmed yet.",
    ...(smokeAt ? { checkedAt: smokeAt } : {})
  });

  const mobileAt = inputs.row?.mobileFieldTestedAt ?? null;
  items.push({
    id: "mobile_field_tested",
    label: "Mobile field tested",
    status: mobileAt ? "green" : "blocker",
    detail: mobileAt
      ? "Operator confirmed a mobile field test."
      : "No mobile field test has been confirmed yet.",
    ...(mobileAt ? { checkedAt: mobileAt } : {})
  });

  return items;
}
