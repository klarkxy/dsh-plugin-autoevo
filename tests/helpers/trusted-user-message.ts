let n = 0
export function trustedUserMessage(text: string) {
  n += 1
  return {
    id: `test_msg_${n}`,
    role: 'user' as const,
    source: { kind: 'user' as const },
    content: [{ type: 'text' as const, text }],
  }
}
