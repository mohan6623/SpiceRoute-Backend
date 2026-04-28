import { Server, Socket } from 'socket.io'
import { getAIResponse, ConversationTurn } from '../services/aiService'
import { detectPromptInjection, RateLimiter } from '../utils/securityUtils'
import { startLiveSession, sendAudioToLiveSession, closeLiveSession } from '../services/liveAIService'
import { createClient } from '@supabase/supabase-js'

const conversationHistory = new Map<string, ConversationTurn[]>()

// Rate limiter: 10 messages per 60 seconds per socket (applies to all users)
const rateLimiter = new RateLimiter(10, 60_000)

// Max conversation history turns to prevent unbounded memory growth
const MAX_HISTORY_TURNS = 20

// Supabase admin client for server-side JWT validation (per Supabase skill guidelines)
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
)

/**
 * Validates a Supabase JWT and returns the authenticated user info.
 * Per Supabase skill: never trust client-provided userId directly.
 * Derive it from the verified JWT only.
 */
async function getVerifiedUser(token?: string): Promise<{ id: string; name?: string } | undefined> {
  if (!token) return undefined
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token)
    if (error || !data.user) return undefined
    return {
      id: data.user.id,
      name: data.user.user_metadata?.full_name || data.user.user_metadata?.name || data.user.email?.split('@')[0],
    }
  } catch {
    return undefined
  }
}

export const registerChatHandlers = (io: Server, socket: Socket) => {
  // Verify the JWT on connect — never trust the raw userId from the client
  const getUserInfo = async (): Promise<{ id: string; name?: string } | undefined> => {
    const token = socket.handshake.auth.token as string | undefined
    return getVerifiedUser(token)
  }

  // ═══════════════════════════════════════════════════════════════
  //  TEXT CHAT EVENTS (existing, unchanged)
  // ═══════════════════════════════════════════════════════════════

  socket.on('session_start', ({ sessionId }: { sessionId: string }) => {
    conversationHistory.set(sessionId, [])
    socket.emit('status', { state: 'idle' })
    console.log(`Session started: ${sessionId} for socket: ${socket.id}`)
  })

  socket.on('text_message', async ({
    text,
    sessionId
  }: {
    text: string
    sessionId: string
  }) => {

    // ── Security Gate 1: Rate Limiting ──────────────────────────
    if (rateLimiter.isRateLimited(socket.id)) {
      console.warn(`🚦 Rate limit exceeded for socket: ${socket.id}`)
      socket.emit('ai_text', {
        text: 'You are sending messages too quickly. Please wait a moment before trying again.'
      })
      socket.emit('status', { state: 'idle' })
      return
    }

    // ── Security Gate 2: Prompt Injection Detection ─────────────
    if (detectPromptInjection(text)) {
      console.warn(`🛡️ Prompt injection attempt blocked for socket: ${socket.id} | Message: "${text.slice(0, 80)}"`)
      socket.emit('ai_text', {
        text: 'I can only help with SpiceRoute parcel support. Is there anything I can assist you with?'
      })
      socket.emit('status', { state: 'idle' })
      return  // Gemini is NOT called — stops the attack at the server
    }

    try {
      socket.emit('status', { state: 'processing' })
      console.log(`📨 Received message in session ${sessionId}: "${text.slice(0, 80)}"`)

      let history = conversationHistory.get(sessionId) || []

      // ── History Truncation: keep last N turns to prevent memory growth ──
      if (history.length > MAX_HISTORY_TURNS * 2) {
        history = history.slice(-MAX_HISTORY_TURNS * 2)
        conversationHistory.set(sessionId, history)
      }

      // ── Security Gate 3: JWT Verification (Supabase skill) ─────
      const userInfo = await getUserInfo()

      const { responseText, updatedHistory } = await getAIResponse(
        text,
        history,
        userInfo?.id,
        userInfo?.name
      )

      conversationHistory.set(sessionId, updatedHistory)

      socket.emit('ai_text', { text: responseText })
      socket.emit('status', { state: 'idle' })

    } catch (err: unknown) {
      console.error('Socket error:', err)
      const message = err instanceof Error ? err.message : 'Something went wrong'
      socket.emit('error', { message })
      socket.emit('status', { state: 'idle' })
    }
  })

  socket.on('session_end', ({ sessionId }: { sessionId: string }) => {
    conversationHistory.delete(sessionId)
    console.log(`Session ended: ${sessionId}`)
  })

  // ═══════════════════════════════════════════════════════════════
  //  VOICE EVENTS (Gemini Live API)
  // ═══════════════════════════════════════════════════════════════

  /**
   * voice_start: Client requests to start a voice session.
   * Opens a persistent Gemini Live WebSocket connection.
   */
  socket.on('voice_start', async () => {
    console.log(`🎙️ Voice start requested from socket: ${socket.id}`)

    // Rate limit voice sessions too
    if (rateLimiter.isRateLimited(socket.id)) {
      socket.emit('voice_error', { message: 'Too many requests. Please wait a moment.' })
      return
    }

    try {
      const userInfo = await getUserInfo()
      await startLiveSession(socket, userInfo)
    } catch (error) {
      console.error(`❌ Failed to start voice session:`, error)
      socket.emit('voice_error', { message: 'Could not start voice. Please try again.' })
    }
  })

  /**
   * voice_audio: Client sends a chunk of PCM audio from the microphone.
   * Forwarded directly to the Gemini Live session.
   */
  socket.on('voice_audio', ({ data, mimeType }: { data: string; mimeType?: string }) => {
    sendAudioToLiveSession(socket.id, data, mimeType || 'audio/pcm;rate=16000')
  })

  /**
   * voice_stop: Client requests to stop voice mode.
   * Closes the Gemini Live session.
   */
  socket.on('voice_stop', async () => {
    console.log(`🔇 Voice stop requested from socket: ${socket.id}`)
    await closeLiveSession(socket.id)
  })

  // ═══════════════════════════════════════════════════════════════
  //  CLEANUP
  // ═══════════════════════════════════════════════════════════════

  socket.on('disconnect', async () => {
    // Clean up voice session on disconnect
    await closeLiveSession(socket.id)
    console.log(`🔌 Socket disconnected, cleaned up voice session: ${socket.id}`)
  })
}
