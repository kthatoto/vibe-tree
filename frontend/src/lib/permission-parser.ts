// Parser for permission requests from AI messages
// Format: <<PERMISSION_REQUEST>>{"action": "switch_to_execution", "reason": "..."}<</PERMISSION_REQUEST>>

const PERMISSION_REGEX = /<<PERMISSION_REQUEST>>([\s\S]*?)<<\/PERMISSION_REQUEST>>/g;

export interface PermissionRequest {
  action: "switch_to_execution";
  reason?: string;
}

export function extractPermissionRequests(content: string): PermissionRequest[] {
  const requests: PermissionRequest[] = [];
  let match;

  while ((match = PERMISSION_REGEX.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed.action === "switch_to_execution") {
        requests.push(parsed as PermissionRequest);
      }
    } catch {
      // Invalid JSON, skip
    }
  }

  // Reset regex lastIndex
  PERMISSION_REGEX.lastIndex = 0;

  return requests;
}

export function removePermissionTags(content: string): string {
  return content.replace(PERMISSION_REGEX, "").trim();
}
