/**
 * CORD Security Engine — Constitutional Oversight & Rejection Detector
 *
 * TypeScript port (2026-09-14) of the real, tested Python implementation at
 * Delentia-OS/rct_control_plane/cord_security.py. That module was genuine,
 * non-trivial logic (Shannon-entropy obfuscation detection + 100 curated
 * prompt-injection regex patterns + payload-size limits) but was never wired
 * into any deployed system — the actually-deployed delentia-mcp-ecosystem
 * Workers gateway had zero prompt-injection defense before this port. This
 * file closes that gap for the one system real users hit.
 *
 * Intentionally NOT ported: GovernanceViolationDetector (FDIA metric-gaming
 * detection). That sub-check is stateful per-agent (a rolling score window)
 * and would need Durable-Object-backed storage, the same pattern already
 * used for MEE growth tracking (see mee-session-do.ts). Out of scope for
 * this pass — flagged as follow-up work, not silently dropped.
 */

export type CORDVerdict = "clean" | "suspicious" | "rejected";

export type CORDCheckType = "entropy" | "injection" | "payload_size";

export interface CORDFinding {
  check_type: CORDCheckType;
  severity: "hard" | "soft";
  pattern_id: string;
  excerpt: string;
  detail: string;
}

export interface CORDResult {
  verdict: CORDVerdict;
  findings: CORDFinding[];
  entropy_score: number;
  input_length: number;
  checked_at: string;
  input_fingerprint: string;
}

// ============================================================================
// 1. Entropy Validator
// ============================================================================

// Max Shannon entropy before triggering (bits per character, 0-8 scale).
// Calibrated for multilingual Unicode (Thai, CJK, English mixed text) —
// same thresholds as the Python original for behavioral parity.
const ENTROPY_HARD_THRESHOLD = 6.8;
const ENTROPY_SOFT_THRESHOLD = 5.6;
const MIN_LENGTH_FOR_ENTROPY = 64;

export function shannonEntropy(text: string): number {
  if (!text) return 0.0;
  const freq = new Map<string, number>();
  // Iterate by Unicode code point (not UTF-16 code unit) to match Python's
  // per-character iteration for multi-byte scripts (Thai/CJK/emoji).
  const chars = Array.from(text);
  for (const ch of chars) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }
  const n = chars.length;
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / n;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function checkEntropy(text: string): CORDFinding[] {
  const findings: CORDFinding[] = [];
  if (text.length < MIN_LENGTH_FOR_ENTROPY) return findings;

  const score = shannonEntropy(text);
  const excerpt = text.length > 80 ? text.slice(0, 80) + "…" : text;

  if (score >= ENTROPY_HARD_THRESHOLD) {
    findings.push({
      check_type: "entropy",
      severity: "hard",
      pattern_id: "CORD-E001",
      excerpt,
      detail: `Shannon entropy ${score.toFixed(2)} bits/char exceeds hard threshold ${ENTROPY_HARD_THRESHOLD}. Input appears obfuscated or contains an encoded payload.`,
    });
  } else if (score >= ENTROPY_SOFT_THRESHOLD) {
    findings.push({
      check_type: "entropy",
      severity: "soft",
      pattern_id: "CORD-E002",
      excerpt,
      detail: `Shannon entropy ${score.toFixed(2)} bits/char is elevated (soft threshold ${ENTROPY_SOFT_THRESHOLD}). May contain encoded data; review before execution.`,
    });
  }

  return findings;
}

// ============================================================================
// 2. Injection Detector — 100 curated patterns, ported 1:1 from
//    cord_security.py's _INJECTION_PATTERNS (same pattern IDs/severities/
//    details, so findings are directly comparable across the TS and Python
//    implementations).
// ============================================================================

interface InjectionPattern {
  pattern_id: string;
  regex: RegExp;
  severity: "hard" | "soft";
  detail: string;
}

const INJECTION_PATTERNS: InjectionPattern[] = [
  // -- Role-switch attacks --------------------------------------------------
  { pattern_id: "CORD-I001", regex: /\bignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|context)/i, severity: "hard", detail: "Classic 'ignore previous instructions' jailbreak." },
  { pattern_id: "CORD-I002", regex: /\byou\s+are\s+now\s+(a|an)\s+\w+/i, severity: "hard", detail: "Role-reassignment attack: 'you are now a [role]'." },
  { pattern_id: "CORD-I003", regex: /\bact\s+as\s+(a|an)\s+\w+(\s+without\s+(restrictions?|filters?|limits?))?/i, severity: "hard", detail: "Role-play injection: 'act as [X] without restrictions'." },
  { pattern_id: "CORD-I004", regex: /\bpretend\s+(you\s+are|to\s+be)\s+(a|an)?\s*\w+/i, severity: "soft", detail: "Persona-switch: 'pretend you are / pretend to be'." },
  { pattern_id: "CORD-I005", regex: /\bforget\s+(your\s+)?(training|guidelines?|rules?|system\s+prompt)/i, severity: "hard", detail: "Training-erasure attack: 'forget your training/guidelines'." },

  // -- DAN / jailbreak keywords ----------------------------------------------
  { pattern_id: "CORD-I006", regex: /\bDAN\b|\bdo\s+anything\s+now\b/i, severity: "hard", detail: "DAN (Do Anything Now) jailbreak keyword detected." },
  { pattern_id: "CORD-I007", regex: /\bjailbreak\b/i, severity: "soft", detail: "Jailbreak keyword detected." },
  { pattern_id: "CORD-I008", regex: /\bunfiltered\s+(mode|response|output|ai)\b/i, severity: "hard", detail: "'Unfiltered mode/AI' bypass attempt." },
  { pattern_id: "CORD-I009", regex: /\bno\s+(safety|ethical?|content)\s+(filter|restriction|guideline)s?/i, severity: "hard", detail: "Request to disable safety filters." },
  { pattern_id: "CORD-I010", regex: /\bdeveloper\s+mode\b|\benable\s+dev\s+mode\b/i, severity: "hard", detail: "'Developer mode' bypass attempt." },

  // -- System prompt extraction ----------------------------------------------
  { pattern_id: "CORD-I011", regex: /\brepeat\s+(your\s+)?(system\s+prompt|instructions?|context|initial\s+prompt)/i, severity: "hard", detail: "System prompt extraction: 'repeat your system prompt'." },
  { pattern_id: "CORD-I012", regex: /\bprint\s+(your\s+)?(system\s+prompt|hidden\s+instructions?)/i, severity: "hard", detail: "System prompt extraction via 'print'." },
  { pattern_id: "CORD-I013", regex: /\bwhat\s+(are|were|is)\s+your\s+(instructions?|system\s+prompt|rules?)\b/i, severity: "soft", detail: "Probe for hidden system instructions." },
  { pattern_id: "CORD-I014", regex: /\bshow\s+(me\s+)?(your\s+)?(full\s+)?(system\s+prompt|initial\s+context)/i, severity: "hard", detail: "System prompt extraction via 'show'." },

  // -- Context confusion / escape sequences -----------------------------------
  { pattern_id: "CORD-I015", regex: /(?:^|\n)\s*#{1,6}\s+(?:system|assistant|user|human|ai)\s*:/im, severity: "hard", detail: "Markdown header role injection (# System: / # User:)." },
  { pattern_id: "CORD-I016", regex: /<\|(?:system|user|assistant|im_start|im_end)\|>/i, severity: "hard", detail: "ChatML token injection (<|system|>, <|im_start|>, etc.)." },
  { pattern_id: "CORD-I017", regex: /\[INST\]|\[\/INST\]|\[SYS\]|\[\/SYS\]/i, severity: "hard", detail: "Llama-2 instruction token injection ([INST], [SYS])." },
  { pattern_id: "CORD-I018", regex: /<<SYS>>|<<\/SYS>>/i, severity: "hard", detail: "Llama-2 system block injection (<<SYS>>)." },
  { pattern_id: "CORD-I019", regex: /\bnew\s+conversation\b|\bnew\s+session\b|\breset\s+context\b/i, severity: "soft", detail: "Context reset injection attempt." },
  { pattern_id: "CORD-I020", regex: /---+\s*(?:system|instructions?|prompt)\s*---+/i, severity: "hard", detail: "HR-delimiter role injection (--- system ---)." },

  // -- Encoding / obfuscation bypasses -----------------------------------------
  { pattern_id: "CORD-I021", regex: /(?:[A-Za-z0-9+/]{40,}={0,2})/, severity: "soft", detail: "Long base64-like string; possible encoded payload." },
  { pattern_id: "CORD-I022", regex: /(?:\\x[0-9a-fA-F]{2}){6,}/, severity: "hard", detail: "Hex escape sequence cluster; obfuscation attempt." },
  { pattern_id: "CORD-I023", regex: /(?:\\u[0-9a-fA-F]{4}){4,}/, severity: "soft", detail: "Unicode escape sequence cluster; possible obfuscation." },
  { pattern_id: "CORD-I024", regex: /(?:0x[0-9a-fA-F]{2}\s*){8,}/, severity: "soft", detail: "Hex byte sequence; possible encoded instruction." },

  // -- Prompt override / goal hijacking ----------------------------------------
  { pattern_id: "CORD-I025", regex: /\byour\s+(only|real|true|actual)\s+(goal|purpose|task|job|instruction)\s+is\b/i, severity: "hard", detail: "Goal hijacking: 'your only/real goal is'." },
  { pattern_id: "CORD-I026", regex: /\bfrom\s+now\s+on\b.{0,40}\b(you\s+(will|must|should)|always|never)\b/i, severity: "hard", detail: "Persistent instruction injection: 'from now on'." },
  { pattern_id: "CORD-I027", regex: /\boverride\s+(your\s+)?(safety|ethical?|guidelines?|constitutional)\b/i, severity: "hard", detail: "Explicit override of constitutional constraints." },
  { pattern_id: "CORD-I028", regex: /\byou\s+(must|should|will)\s+(now\s+)?bypass\b/i, severity: "hard", detail: "Explicit bypass instruction." },
  { pattern_id: "CORD-I029", regex: /\bthink\s+step\s+by\s+step\s+about\s+how\s+to\s+(?:bypass|jailbreak|hack)\b/i, severity: "hard", detail: "Chain-of-thought bypass scaffolding." },
  { pattern_id: "CORD-I030", regex: /\bhypothetically\s+speaking\s*,?\s*(?:if\s+)?(?:you\s+could|there\s+were)\b/i, severity: "soft", detail: "Hypothetical framing to bypass constraints." },

  // -- Exfiltration attempts -----------------------------------------------------
  { pattern_id: "CORD-I031", regex: /\bsend\s+(this|the)\s+(to|data|payload|context)\s+(http|https|ftp|webhook)\b/i, severity: "hard", detail: "Exfiltration via URL injection." },
  { pattern_id: "CORD-I032", regex: /\bfetch\s+(?:http|https):\/\/\S+/i, severity: "hard", detail: "SSRF / data exfiltration attempt via fetch." },
  { pattern_id: "CORD-I033", regex: /\b(?:curl|wget|nc|ncat|netcat)\s+(?:-\w+\s+)*https?:\/\/\S+/i, severity: "hard", detail: "Shell command injection (curl/wget/netcat)." },
  { pattern_id: "CORD-I034", regex: /\beval\s*\(|exec\s*\(|__import__\s*\(/i, severity: "hard", detail: "Python code injection (eval/exec/__import__)." },
  { pattern_id: "CORD-I035", regex: /<script[^>]*>|javascript\s*:/i, severity: "hard", detail: "XSS / script injection attempt." },

  // -- Multi-language bypasses -----------------------------------------------------
  { pattern_id: "CORD-I036", regex: /\b(?:ignorieren|ignorez|ignorer|ignora)\s+(?:alle|vorige|previous)\b/i, severity: "soft", detail: "Multi-language 'ignore' bypass (DE/FR/ES)." },
  { pattern_id: "CORD-I037", regex: /เพิกเฉย.{0,20}(?:คำสั่ง|ระบบ|instructions?)/i, severity: "soft", detail: "Thai-language injection attempt." },

  // -- FDIA / constitutional bypass -------------------------------------------------
  { pattern_id: "CORD-I038", regex: /\bset\s+(?:fdia|alignment|desire|intent)\s*=\s*[0-9.]+/i, severity: "hard", detail: "Direct FDIA parameter manipulation attempt." },
  { pattern_id: "CORD-I039", regex: /\bset\s+governance\s*(factor\s*)?=\s*1\b/i, severity: "hard", detail: "Governance factor override to 1.0 (bypass attempt)." },
  { pattern_id: "CORD-I040", regex: /\bfdia\s*score\s*(?:is|=|:)\s*(?:0\.9[5-9]|1\.0)/i, severity: "soft", detail: "Suspicious FDIA score claim >= 0.95 in text." },

  // -- Indirect injection (data-path) -------------------------------------------------
  { pattern_id: "CORD-I041", regex: /\[hidden\s+instructions?\]|\[secret\s+prompt\]/i, severity: "hard", detail: "Hidden instruction marker in text." },
  { pattern_id: "CORD-I042", regex: /<!--.*?-->/s, severity: "soft", detail: "HTML comment block; possible hidden instruction." },
  { pattern_id: "CORD-I043", regex: /\/\*.*?\*\//s, severity: "soft", detail: "C-style comment block; possible hidden instruction." },
  { pattern_id: "CORD-I044", regex: /\bstop\b.{0,20}\bfollowing\b.{0,20}\b(rules?|instructions?|guidelines?)/i, severity: "hard", detail: "Explicit instruction to stop following rules." },
  { pattern_id: "CORD-I045", regex: /\byou\s+are\s+free\s+to\b|\bno\s+longer\s+bound\b/i, severity: "hard", detail: "Constraint liberation framing." },

  // -- Additional hard stops -----------------------------------------------------------
  { pattern_id: "CORD-I046", regex: /\bsudo\b.{0,30}\b(override|bypass|disable|unlock)\b/i, severity: "hard", detail: "sudo-privilege escalation framing." },
  { pattern_id: "CORD-I047", regex: /\badmin\s+mode\b|\broot\s+access\b|\bsuperuser\s+mode\b/i, severity: "hard", detail: "Privilege escalation keyword." },
  { pattern_id: "CORD-I048", regex: /\bGPT-4\s+is\s+now\s+(a|in)\b|\bClaude\s+is\s+now\b/i, severity: "hard", detail: "Model identity substitution attack." },
  { pattern_id: "CORD-I049", regex: /\btoken\s+limit\b.{0,40}\bbypass\b|\bcontext\s+window\b.{0,40}\boverflow\b/i, severity: "soft", detail: "Context overflow / token-limit exploit attempt." },
  { pattern_id: "CORD-I050", regex: /\binfinite\s+loop\b|\brecurse\s+forever\b|\bwhile\s+true\b/i, severity: "soft", detail: "DoS via infinite loop / recursion hint." },

  // -- Multi-language: Thai injection (I051-I055) ---------------------------------------
  { pattern_id: "CORD-I051", regex: /ละเว้น.{0,20}(?:คำสั่ง|ระบบ|system)/i, severity: "hard", detail: "Thai: 'ละเว้น' (ignore) combined with instruction/system keyword." },
  { pattern_id: "CORD-I052", regex: /เพิกเฉย.{0,30}(?:กฎ|คำสั่ง|ข้อจำกัด)/i, severity: "hard", detail: "Thai: 'เพิกเฉย' (disregard) combined with rules/restrictions." },
  { pattern_id: "CORD-I053", regex: /ตอนนี้คุณคือ|คุณเป็น.{0,20}(?:ที่ไม่มี|ปราศจาก)(?:ข้อจำกัด|กฎ)/i, severity: "hard", detail: "Thai role-reassignment: 'ตอนนี้คุณคือ' (now you are)." },
  { pattern_id: "CORD-I054", regex: /ลืม.{0,30}(?:คำสั่ง|การฝึก|ระบบ)/i, severity: "soft", detail: "Thai: 'ลืม' (forget) training/system instructions." },
  { pattern_id: "CORD-I055", regex: /บอก.{0,20}(?:system prompt|คำสั่งระบบ|prompt เดิม)/i, severity: "hard", detail: "Thai: 'บอก' (tell me) system prompt extraction attempt." },

  // -- Multi-language: Chinese injection (I056-I058) --------------------------------------
  { pattern_id: "CORD-I056", regex: /忽略.{0,20}(?:之前|所有|上面).{0,20}(?:指令|提示|规则)/i, severity: "hard", detail: "Chinese: 忽略 (ignore) previous instructions/rules." },
  { pattern_id: "CORD-I057", regex: /现在你是|你现在是.{0,20}(?:没有|不受).{0,20}(?:限制|约束)/i, severity: "hard", detail: "Chinese role-reassignment: 现在你是 (now you are) without restrictions." },
  { pattern_id: "CORD-I058", regex: /输出.{0,20}(?:系统提示|system prompt|初始指令)/i, severity: "hard", detail: "Chinese: 输出 (output) system prompt extraction attempt." },

  // -- Multi-language: Japanese injection (I059-I061) --------------------------------------
  { pattern_id: "CORD-I059", regex: /前の指示を無視|すべての指示を無視/i, severity: "hard", detail: "Japanese: 'ignore previous/all instructions'." },
  { pattern_id: "CORD-I060", regex: /あなたは今.{0,20}(?:制限なし|フィルターなし|自由)/i, severity: "hard", detail: "Japanese: 'you are now without restrictions/filters'." },
  { pattern_id: "CORD-I061", regex: /システムプロンプト.{0,20}(?:を出力|を教えて|を表示)/i, severity: "hard", detail: "Japanese: system prompt extraction attempt." },

  // -- Encoding bypass: URL / percent-encoding (I062-I064) ------------------------------------
  { pattern_id: "CORD-I062", regex: /(?:%[0-9a-fA-F]{2}){8,}/, severity: "soft", detail: "Percent-encoded sequence cluster; possible URL-encoded injection." },
  { pattern_id: "CORD-I063", regex: /&#x[0-9a-fA-F]+;|&#\d+;/, severity: "soft", detail: "HTML entity encoding; possible character obfuscation." },
  { pattern_id: "CORD-I064", regex: /\\\d{3}(?:\\\d{3}){3,}/, severity: "soft", detail: "Octal escape sequence cluster; obfuscation attempt." },

  // -- Indirect / data-path injection (I065-I069) ------------------------------------------
  { pattern_id: "CORD-I065", regex: /"role"\s*:\s*"system"|'role'\s*:\s*'system'/i, severity: "hard", detail: "JSON role:system field injection; ChatML data-path attack." },
  { pattern_id: "CORD-I066", regex: /&anchor\s|<<\s*:\s*\*|yaml\s+anchor\s+injection/i, severity: "soft", detail: "YAML anchor/alias abuse; indirect injection via config data." },
  { pattern_id: "CORD-I067", regex: /\{\{.{0,60}\}\}|\{%.{0,60}%\}/, severity: "soft", detail: "Template injection (Jinja2/Twig/Handlebars) detected." },
  { pattern_id: "CORD-I068", regex: /\$\{.{0,60}\}|\$\(.{0,60}\)/, severity: "soft", detail: "Shell variable or command substitution; SSTI/injection risk." },
  { pattern_id: "CORD-I069", regex: /(?:--|;)\s*(?:DROP|SELECT|INSERT|UPDATE|DELETE|UNION)\b/i, severity: "hard", detail: "SQL injection attempt in natural-language payload." },

  // -- Chain-of-thought manipulation (I070-I074) -----------------------------------------------
  { pattern_id: "CORD-I070", regex: /\blet.{0,10}think\b.{0,40}\bhow\s+to\s+(?:bypass|jailbreak|evade|circumvent)\b/i, severity: "hard", detail: "CoT bypass scaffolding: 'let's think how to bypass'." },
  { pattern_id: "CORD-I071", regex: /\bstep\s+\d+\b.{0,40}\bstep\s+\d+\b.{0,40}\bjailbreak\b/i, severity: "hard", detail: "Step-by-step jailbreak scaffolding." },
  { pattern_id: "CORD-I072", regex: /\bfirst\s*,\s*.{0,40}\bsecond\s*,\s*.{0,40}\bbypass\b/i, severity: "soft", detail: "Sequential instruction with bypass keyword." },
  { pattern_id: "CORD-I073", regex: /\bchain\s+of\s+thought\b.{0,60}\b(?:bypass|unrestricted|uncensored)\b/i, severity: "hard", detail: "CoT framing explicitly targeting unrestricted output." },
  { pattern_id: "CORD-I074", regex: /\bif\s+you\s+were\s+(?:a|an)\s+\w+\s+without\s+(?:any\s+)?(?:restrictions?|guidelines?|ethics?)\b/i, severity: "hard", detail: "Counterfactual persona attack: 'if you were X without restrictions'." },

  // -- Roleplay / persona escalation (I075-I079) -----------------------------------------------
  { pattern_id: "CORD-I075", regex: /\bplay\s+(the\s+)?role\s+of\b.{0,40}\b(?:evil|malicious|uncensored|without\s+restrictions?)\b/i, severity: "hard", detail: "Roleplay instruction targeting uncensored/evil persona." },
  { pattern_id: "CORD-I076", regex: /\bstay\s+in\s+character\b.{0,60}\b(?:never\s+break|always\s+respond)/i, severity: "soft", detail: "Persistent character-lock with universal response mandate." },
  { pattern_id: "CORD-I077", regex: /\bcharacter\s+(?:named|called)\b.{0,40}\b(?:has\s+no\s+restrictions?|can\s+do\s+anything)\b/i, severity: "hard", detail: "Named character with no-restrictions framing." },
  { pattern_id: "CORD-I078", regex: /\bAIM\b|\bALEX\b.{0,30}\bunethical\b|\bGOD\s+MODE\b/i, severity: "hard", detail: "Known jailbreak persona names: AIM, ALEX-unethical, GOD MODE." },
  { pattern_id: "CORD-I079", regex: /\bopposite\s+(day|mode|world)\b.{0,60}\b(?:everything\s+(?:bad|harmful|illegal)\s+is\s+(?:good|allowed))\b/i, severity: "hard", detail: "Opposite-day framing to invert safety constraints." },

  // -- Token smuggling / invisible chars (I080-I083) -------------------------------------------
  { pattern_id: "CORD-I080", regex: /[​‌‍﻿⁠]/, severity: "soft", detail: "Zero-width character detected; possible token-smuggling attempt." },
  { pattern_id: "CORD-I081", regex: /[̀-ͯ҉]{3,}/, severity: "soft", detail: "Combining diacritics cluster; possible homoglyph obfuscation." },
  { pattern_id: "CORD-I082", regex: /[-]/, severity: "soft", detail: "Private-use Unicode area character; possible steganographic injection." },
  { pattern_id: "CORD-I083", regex: /(?:[а-яΑ-ω].*?){4,}/, severity: "soft", detail: "Cyrillic/Greek homoglyph cluster; likely Latin word obfuscation." },

  // -- Prompt format confusion (I084-I088) -------------------------------------------------------
  { pattern_id: "CORD-I084", regex: /<\|(?:begin|end)_of_text\|>|<\|eot_id\|>/i, severity: "hard", detail: "Llama-3 special token injection (<|begin_of_text|>, <|eot_id|>)." },
  { pattern_id: "CORD-I085", regex: /<\/?s>|<\|pad\|>|<\|sep\|>/i, severity: "soft", detail: "Special separator token injection (</s>, <|sep|>, etc.)." },
  { pattern_id: "CORD-I086", regex: /HUMAN:\s*\n|ASSISTANT:\s*\n|BOT:\s*\n/i, severity: "hard", detail: "Turn-delimiter injection (HUMAN:/ASSISTANT:/BOT: headers)." },
  { pattern_id: "CORD-I087", regex: /```\s*system\s*\n|```\s*instructions?\s*\n/i, severity: "hard", detail: "Markdown code-fence role injection (```system, ```instructions)." },
  { pattern_id: "CORD-I088", regex: /\[SYSTEM\]|\[INST\s+\w/i, severity: "hard", detail: "Square-bracket role token injection ([SYSTEM], [INST ...])." },

  // -- Adversarial goal hijacking (I089-I093) -------------------------------------------------------
  { pattern_id: "CORD-I089", regex: /\bthe\s+(?:previous|above|prior)\s+(?:message|task|request)\s+(?:was|is)\s+(?:a\s+)?(?:test|trick|joke)\b/i, severity: "soft", detail: "Legitimacy-undercutting: 'the previous message was a test/trick'." },
  { pattern_id: "CORD-I090", regex: /\byour\s+(?:real|true|actual)\s+purpose\s+(?:is|was)\s+to\b/i, severity: "hard", detail: "Purpose-reframing: 'your real purpose is to...'." },
  { pattern_id: "CORD-I091", regex: /\bresearch\s+purposes?\s+only\b.{0,60}\b(?:how\s+to|steps?\s+to)\b/i, severity: "soft", detail: "'Research purposes only' framing with how-to request." },
  { pattern_id: "CORD-I092", regex: /\bfiction(?:al)?\b.{0,40}\b(?:character|story)\b.{0,60}\b(?:explain|describe|provide)\b.{0,40}\b(?:how\s+to|steps?)\b/i, severity: "soft", detail: "Fictional framing used to elicit procedural instructions." },
  { pattern_id: "CORD-I093", regex: /\beducational\s+(?:purposes?|context)\b.{0,60}\b(?:detailed?\s+)?(?:steps?|instructions?|guide)\b.{0,40}\b(?:harm|attack|exploit|bypass)\b/i, severity: "hard", detail: "Educational framing combined with harm/exploit keyword." },

  // -- Agentic / tool-use hijacking (I094-I098) ---------------------------------------------------------
  { pattern_id: "CORD-I094", regex: /\bcall\s+(?:the\s+)?(?:(?:delete|drop|rm|format)\s+)?(?:tool|function|api)\b|\bcall\s+(?:the\s+)?(?:tool|function|api)\b.{0,40}\b(?:delete|drop|rm|format)\b/i, severity: "hard", detail: "Agentic tool-call injection targeting destructive actions." },
  { pattern_id: "CORD-I095", regex: /\buse\s+(?:the\s+)?(?:write|create|execute)\s+(?:tool|function)\b.{0,60}\b(?:malware|ransomware|backdoor|exploit)\b/i, severity: "hard", detail: "Tool-call injection to create malware/backdoor/exploit." },
  { pattern_id: "CORD-I096", regex: /\bsend\s+(?:an?\s+)?(?:email|message|webhook)\b.{0,60}\b(?:with\s+the\s+(?:system\s+)?(?:prompt|context|memory))\b/i, severity: "hard", detail: "Exfiltration via agentic send action with system context." },
  { pattern_id: "CORD-I097", regex: /\bautonomously\b.{0,40}\b(?:without\s+(?:asking|confirming|permission))\b/i, severity: "soft", detail: "Autonomy escalation: act without permission/confirmation." },
  { pattern_id: "CORD-I098", regex: /\bignore\s+(?:the\s+)?(?:(?:approval|human|user)\s+){1,2}(?:step|gate|check|review)\b/i, severity: "hard", detail: "Approval gate bypass: ignore human-in-the-loop step." },

  // -- Miscellaneous hard stops (I099-I100) ---------------------------------------------------------------
  { pattern_id: "CORD-I099", regex: /\bpassword\s+is\b.{0,40}\bplease\s+(?:use|enter|provide)\b|\bsecret\s+key\s*[:=]/i, severity: "soft", detail: "Credential injection attempt in payload." },
  { pattern_id: "CORD-I100", regex: /\bremember\s+this\s+for\s+(?:all\s+)?(?:future|subsequent|next)\s+(?:messages?|requests?|conversations?)\b/i, severity: "hard", detail: "Persistent memory poisoning: 'remember this for future messages'." },
];

// Pre-sorted: hard before soft for early exit, matching the Python original.
const SORTED_PATTERNS = [...INJECTION_PATTERNS].sort((a, b) => (a.severity === "hard" ? 0 : 1) - (b.severity === "hard" ? 0 : 1));

function checkInjection(text: string): CORDFinding[] {
  const findings: CORDFinding[] = [];
  for (const pat of SORTED_PATTERNS) {
    const m = pat.regex.exec(text);
    if (m) {
      const start = Math.max(0, m.index - 20);
      const end = Math.min(text.length, m.index + m[0].length + 20);
      let excerpt = text.slice(start, end).replace(/\n/g, " ");
      if (excerpt.length > 120) excerpt = excerpt.slice(0, 117) + "…";
      findings.push({
        check_type: "injection",
        severity: pat.severity,
        pattern_id: pat.pattern_id,
        excerpt,
        detail: pat.detail,
      });
    }
  }
  return findings;
}

// ============================================================================
// 3. Payload Size Validator
// ============================================================================

const MAX_PAYLOAD_BYTES_HARD = 1_048_576; // 1 MB
const MAX_PAYLOAD_BYTES_SOFT = 131_072; // 128 KB

function checkPayloadSize(text: string): CORDFinding[] {
  const size = new TextEncoder().encode(text).length;
  if (size > MAX_PAYLOAD_BYTES_HARD) {
    return [{
      check_type: "payload_size",
      severity: "hard",
      pattern_id: "CORD-S001",
      excerpt: `${size.toLocaleString()} bytes`,
      detail: `Payload size ${size.toLocaleString()} bytes exceeds hard limit ${MAX_PAYLOAD_BYTES_HARD.toLocaleString()} bytes (1 MB). Rejecting.`,
    }];
  }
  if (size > MAX_PAYLOAD_BYTES_SOFT) {
    return [{
      check_type: "payload_size",
      severity: "soft",
      pattern_id: "CORD-S002",
      excerpt: `${size.toLocaleString()} bytes`,
      detail: `Payload size ${size.toLocaleString()} bytes exceeds soft limit ${MAX_PAYLOAD_BYTES_SOFT.toLocaleString()} bytes (128 KB). Review before executing.`,
    }];
  }
  return [];
}

// ============================================================================
// 4. CORD Engine (orchestrator)
// ============================================================================

function determineVerdict(findings: CORDFinding[]): CORDVerdict {
  if (findings.some((f) => f.severity === "hard")) return "rejected";
  if (findings.some((f) => f.severity === "soft")) return "suspicious";
  return "clean";
}

async function sha256Hex16(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < 8; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

/**
 * Run all CORD checks (entropy, injection, payload size) on a text string.
 * Mirrors cord_security.py's CORDEngine.check() (governance/metric-gaming
 * tracking intentionally excluded — see file header).
 */
export async function cordCheck(text: string): Promise<CORDResult> {
  const [fingerprint] = await Promise.all([sha256Hex16(text)]);
  const entropy = shannonEntropy(text);

  const findings: CORDFinding[] = [
    ...checkPayloadSize(text),
    ...checkEntropy(text),
    ...checkInjection(text),
  ];

  return {
    verdict: determineVerdict(findings),
    findings,
    entropy_score: Math.round(entropy * 10000) / 10000,
    input_length: text.length,
    checked_at: new Date().toISOString(),
    input_fingerprint: fingerprint,
  };
}

/**
 * Flattens all string values found anywhere in a JSON-like value (object,
 * array, or scalar) into one text blob for CORD scanning — MCP tool
 * arguments vary in shape per tool (problem_statement, target_payload,
 * action_name, ...), so this scans all of them rather than special-casing
 * each tool's argument schema.
 */
export function extractCordText(value: unknown, depth = 0): string {
  if (depth > 6) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v) => extractCordText(v, depth + 1)).join(" ");
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>)
      .map((v) => extractCordText(v, depth + 1))
      .join(" ");
  }
  return "";
}
