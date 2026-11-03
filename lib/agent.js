// Single agent, manual tool-use loop. All model access goes through Amazon Bedrock: FTUSA's technical
// document prohibits direct calls to third-party model APIs (including the Anthropic API).
import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import { TOOL_DEFS, runTool, newSessionState, detectPii } from './tools.js';
import { TAGS } from './generate.js';

const PROVIDER = 'bedrock';
const REGION = process.env.AWS_REGION || 'us-east-1';
const MODEL = process.env.MODEL || 'anthropic.claude-opus-5-5';
if (process.env.ANTHROPIC_API_KEY) console.warn('ANTHROPIC_API_KEY is set but ignored: this app only calls Claude through Amazon Bedrock.');
let client;
const getClient = () => (client ??= new AnthropicBedrockMantle({ awsRegion: REGION }));

// Limits so a public demo cannot run up unbounded model spend or memory.
const MAX_TURNS_PER_SESSION = Number(process.env.MAX_TURNS_PER_SESSION || 30);
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 500);

export const GREETINGS = {
  en: "Hello, and thank you for taking the time. I'm the Fair Trade USA Producer Exchange assistant. What has been most difficult for you or your organization recently?",
  es: 'Hola, y gracias por su tiempo. Soy el asistente de Intercambio de Productores de Fair Trade USA. ¿Qué ha sido lo más difícil para usted o su organización últimamente?',
  fr: "Bonjour, et merci de prendre ce temps. Je suis l'assistant d'échange avec les producteurs de Fair Trade USA. Qu'est-ce qui a été le plus difficile pour vous ou votre organisation récemment ?",
};

const SYSTEM = `You are the Fair Trade USA Producer Exchange Agent. You talk with farmers, fishers and workers in Fair Trade certified producer organizations. A producer describes a challenge; you return (a) what the data shows about it for their crop and region and (b) what comparable producers did, each cited and tied to certification standard clauses. Your role is to inform the producer's own decision, never to direct it.

Conversation protocol (follow in order, one or two questions per turn, short plain sentences):
1. You have already greeted the producer with an open question about what has been difficult. Listen.
2. Follow up on: when it started, how severe it is, and what they have already tried.
3. Call get_session_profile and confirm their location and entity type (e.g. individual farm vs cooperative). They may correct it; the corrected version wins.
4. Play back your understanding in a short paragraph (challenge, timing, severity, what was tried, location, entity type) and ask them to confirm or correct it. Do not retrieve guidance until they confirm.
5. Retrieve: get_producer_history, get_regional_context and find_peer_examples with the matching challenge tags, and search_standards for the challenge and for each candidate example.
6. Call prepare_guidance with your insights and examples. If it returns errors, fix them and call it again. Never present guidance that has not passed.
7. Present the guidance: 1-3 insights from the data and 1-3 peer examples. After each, show its citation in square brackets with the source id and dataset or peer organization, and the related standard clause id(s), e.g. "[Source: RF-CO-CAU-CHIRPS, CHIRPS rainfall · Standard: APS-DEMO-4.1]". Mention that regional figures in this sandbox are synthetic stand-ins.
8. Ask whether this was helpful, and ask whether you may store a summary of this conversation in their organization's record (it is marked as an agent conversation, separate from compliance reporting, and reviewed by Fair Trade USA staff).
9. If yes to storing: call save_exchange_record (challenge_summary uses the confirmed, corrected understanding, close to their own words). If no: call record_declined with stage "declined_storage". Then close warmly.

Rules:
- Reply in the producer's language (they may write in English, Spanish, French or another language). Keep tags in English from this set: ${TAGS.join('; ')}.
- Consent: if at any point the producer says they would rather not continue or not be recorded, stop asking questions, do not retrieve anything further, call record_declined, and acknowledge respectfully. Declining is a successful outcome.
- Personal information: if the producer names a specific individual or shares contact details (phone, email, address), call flag_pii. Never redact, rephrase or remove their words.
- Out of scope: you only discuss challenges and return data and peer examples. You cannot check certification status, audits or compliance, receive worker-voice or grievance complaints, give legal or financial instructions, or look up another producer. For such requests call log_out_of_scope, explain plainly why you cannot help and where they might go instead (their organization's leadership or Fair Trade USA's usual channels), then offer to return to their challenge. Never include the out-of-scope request in a summary.
- Only state facts that come from tool results. Never invent numbers, sources, organizations or clauses.
- Plain text only, no markdown headings or tables. Short bullet lines are fine for guidance.`;

const sessions = new Map();

export function startSession({ producerId, lang = 'en' }) {
  const id = crypto.randomUUID();
  const greeting = GREETINGS[lang] || GREETINGS.en;
  if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value); // evict the oldest
  sessions.set(id, { id, lang, state: newSessionState(producerId), messages: [], greeting, events: [], turns: 0 });
  return { sessionId: id, greeting };
}
export const getSession = (id) => sessions.get(id);

export class SessionError extends Error {}

export async function chat(sessionId, userText, ctx) {
  const s = sessions.get(sessionId);
  // Sessions live in memory: on Vercel a request can land on another instance. Durable sessions
  // (AgentCore Runtime or DynamoDB) are the real fix; until then, tell the user plainly.
  if (!s) throw new SessionError('This conversation is no longer available on the server. Please start a new conversation.');
  if (++s.turns > MAX_TURNS_PER_SESSION) throw new SessionError('This conversation has reached its length limit. Please start a new conversation.');
  const piiKinds = detectPii(userText);
  piiKinds.forEach((kind) => s.state.pii.push({ kind, by: 'server_pattern', at: new Date().toISOString() }));

  // First user turn carries the (already shown) greeting as context so history starts with a user message.
  const content = s.messages.length ? userText : `[You opened the conversation with: "${s.greeting}"]\n\nProducer: ${userText}`;
  s.messages.push({ role: 'user', content });
  const toolEvents = [];

  for (let i = 0; i < 12; i++) {
    const params = {
      model: MODEL, max_tokens: 16000,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      tools: TOOL_DEFS, messages: s.messages,
      output_config: { effort: 'medium' },
    };
    const res = await getClient().messages.create(params);
    s.messages.push({ role: 'assistant', content: res.content });

    if (res.stop_reason === 'refusal') return { reply: 'Sorry, I could not continue this conversation. Please try rephrasing.', toolEvents, state: view(s) };
    if (res.stop_reason === 'max_tokens') return { reply: 'Sorry, my answer was cut off. Please send your message again.', toolEvents, state: view(s) };
    if (res.stop_reason === 'pause_turn') continue;
    const uses = res.content.filter((b) => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || !uses.length) {
      return { reply: res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(), toolEvents, state: view(s) };
    }
    const results = uses.map((u) => {
      let out;
      try { out = runTool(u.name, u.input, { ...ctx, state: s.state }); } catch (e) { out = { error: e.message }; }
      toolEvents.push({ tool: u.name, input: u.input, ok: !out.error && out.ok !== false });
      return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out), is_error: !!out.error };
    });
    s.messages.push({ role: 'user', content: results });
  }
  return { reply: '(The assistant took too many steps; please send your message again.)', toolEvents, state: view(s) };
}

const view = (s) => ({ guidance: s.state.guidance, pii: s.state.pii, closed: s.state.closed, outOfScope: s.state.outOfScope, reasoningLog: s.state.reasoningLog });
export const providerInfo = () => ({ provider: PROVIDER, model: MODEL, region: REGION });
