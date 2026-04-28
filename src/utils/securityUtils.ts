/**
 * securityUtils.ts
 * Security utilities for the SpiceRoute AI chatbot.
 * Prevents prompt injection, sanitizes user input, and rate-limits abuse.
 */

// ────────────────────────────────────────────────────────────────
// Input Sanitization
// ────────────────────────────────────────────────────────────────

const MAX_MESSAGE_LENGTH = 500

/**
 * Sanitizes a user message before it is passed to any AI or database layer.
 * - Strips HTML tags
 * - Removes null bytes and ASCII control characters (0x00–0x1F, except 0x09/0x0A/0x0D)
 * - Trims whitespace
 * - Truncates to MAX_MESSAGE_LENGTH characters
 */
export function sanitizeInput(text: string): string {
  return text
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') // strip <script> + content
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')    // strip <style> + content
    .replace(/<[^>]*>/g, '')          // strip remaining HTML tags (keep inner text)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '') // remove control chars (keep tab/LF/CR)
    .replace(/\x00/g, '')             // belt-and-suspenders null byte removal
    .trim()
    .slice(0, MAX_MESSAGE_LENGTH)
}

// ────────────────────────────────────────────────────────────────
// Prompt Injection Detection
// ────────────────────────────────────────────────────────────────

const INJECTION_PATTERNS: RegExp[] = [
  // Instruction override
  /ignore\s+(all\s+)?(previous|above)\s+instructions?/i,
  /forget\s+(your|all|the)\s+(instructions?|rules?|context|prompt)/i,
  /disregard\s+(all\s+)?(previous|your)\s+(instructions?|rules?)/i,
  /override\s+(your\s+)?(instructions?|rules?|guidelines?)/i,

  // Persona hijacking
  /you\s+are\s+now\s+/i,
  /act\s+as\s+(a\s+|an\s+)?(?!.*spiceroute)/i,   // "act as X" but not "act as a SpiceRoute agent"
  /pretend\s+(you\s+are|to\s+be)/i,
  /roleplay\s+as/i,
  /your\s+new\s+(role|persona|instructions?|task)\s+(is|are)?/i,

  // System prompt extraction
  /\b(reveal|show|tell\s+me|print|output|repeat|display|share)\b.{0,30}\b(system\s+prompt|instructions?|rules?|guidelines?)\b/i,
  /what\s+(are\s+)?(your|the)\s+(instructions?|rules?|system\s+prompt)/i,

  // Token injection (common LLM attack vectors)
  /\[SYSTEM\]/i,
  /<system>/i,
  /<\|im_start\|>\s*system/i,
  /###\s*system/i,

  // DAN and jailbreak patterns
  /\bDAN\b.*freed?/i,
  /do\s+anything\s+now/i,
  /jailbreak/i,
  /no\s+(restrictions?|limitations?|filters?|rules?|guidelines?)/i,
]

/**
 * Returns true if the message contains a known prompt injection attempt.
 * Detection is case-insensitive. The Gemini call is skipped entirely when true.
 */
export function detectPromptInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(text))
}

// ────────────────────────────────────────────────────────────────
// Rate Limiter
// ────────────────────────────────────────────────────────────────

interface WindowEntry {
  count: number
  windowStart: number
}

/**
 * In-memory sliding-window rate limiter keyed by socket ID.
 * Thread-safe for Node.js single-threaded event loop.
 *
 * @param maxRequests  Maximum allowed requests per window
 * @param windowMs     Window duration in milliseconds
 */
export class RateLimiter {
  private store = new Map<string, WindowEntry>()

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number
  ) {}

  /**
   * Returns true if the caller has exceeded their quota.
   * Always call this before processing a message — it increments the counter.
   */
  isRateLimited(socketId: string): boolean {
    const now = Date.now()
    const entry = this.store.get(socketId)

    if (!entry || now - entry.windowStart >= this.windowMs) {
      // New window
      this.store.set(socketId, { count: 1, windowStart: now })
      return false
    }

    if (entry.count >= this.maxRequests) {
      return true
    }

    entry.count++
    return false
  }

  /** Cleans up stale entries (call periodically in long-running servers). */
  cleanup(): void {
    const now = Date.now()
    for (const [id, entry] of this.store.entries()) {
      if (now - entry.windowStart >= this.windowMs) {
        this.store.delete(id)
      }
    }
  }
}
