// ============================================================================
// أوفق AI Agent v3.0 — محرك التشغيل والرندر الذكي المطور (Ultra-Lean Core)
//
// أداة واحدة رئيسية: run_terminal.
// الـ Agent يمتلك الاستقلالية الكاملة للتحكم في بيئة التشغيل عبر التيرمينال:
// 1. استقبال كود المشاهد المباشرة، أو روابط Raw، أو استخراجها من ملفات الهوية.
// 2. إنشاء الـ Release على GitHub وتسميته وإدارته بالكامل.
// 3. رندر الفيديوهات ودمجها عبر ffmpeg ورفع كافة الأصول المكتملة.
// 4. إنهاء المهمة بمجرد كتابة ملف TASK_COMPLETE.json.
// ============================================================================

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WORK_DIR = process.cwd();
const AGENT_LOG_FILE = path.join(WORK_DIR, 'agent_run_log.txt');

function log(msg) {
  const line = `[agent ${new Date().toISOString()}] ${msg}`;
  console.error(line);
  try {
    fs.appendFileSync(AGENT_LOG_FILE, line + '\n');
  } catch (e) {
    // استمرار عمل اللوج عبر console.error في حال تعذر الكتابة للملف
  }
}

// ============================================================================
// إعدادات البيئة، المفاتيح، وسلسلة النماذج
// ============================================================================
const GEMINI_API_KEYS = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
let currentKeyIndex = 0;

const MODEL_CHAIN = (process.env.GEMINI_MODEL_CHAIN || 'gemini-3.5-flash-lite,gemini-3.5-flash-lite,gemini-3.1-flash-lite')
  .split(',').map((s) => s.trim()).filter(Boolean);
let currentModelIndex = 0;

const TASK_JSON = process.env.TASK_JSON || 'نفّذ رندر المشهد المطلوب بدقة، سواء كان كوداً ملصوقاً، رابط Raw، أو بناءً من ملف هوية، وادمج المشاهد ووثقها إن طُلب ذلك.';
const CALLBACK_URL = process.env.CALLBACK_URL || '';
const GH_REPO = process.env.GITHUB_REPOSITORY || '';
process.env.GH_REPO = GH_REPO;

const MAX_TURNS = 80;
const TASK_COMPLETE_MARKER = 'TASK_COMPLETE.json';

// ---------------------------------------------------------------------------
// الأداة الوحيدة: تنفيذ أوامر Bash الحقيقية
// ---------------------------------------------------------------------------
async function runTerminal({ command }) {
  const OUTPUT_LIMIT = 40000;
  const ERROR_LIMIT = 20000;

  function withTruncationNotice(text, limit) {
    if (text.length <= limit) return text;
    return (
      text.slice(0, limit) +
      `\n\n...[تنبيه: تم اقتطاع الناتج هنا لتجاوز الحد المسموح. الحجم الكلي كان ${text.length} حرفاً، وهذا عرض أول ${limit} حرف فقط.]...`
    );
  }

  try {
    const output = execSync(command, {
      cwd: WORK_DIR,
      env: process.env,
      timeout: 25 * 60 * 1000, // مهلة 25 دقيقة للأوامر الطويلة
      maxBuffer: 35 * 1024 * 1024,
      shell: '/bin/bash',
    }).toString();
    return { success: true, exit_code: 0, output: withTruncationNotice(output, OUTPUT_LIMIT) };
  } catch (e) {
    return {
      success: false,
      exit_code: e.status ?? null,
      error: e.message,
      stdout: withTruncationNotice((e.stdout || '').toString(), ERROR_LIMIT),
      stderr: withTruncationNotice((e.stderr || '').toString(), ERROR_LIMIT),
    };
  }
}

const functionDeclarations = [
  {
    name: 'run_terminal',
    description:
      'الأداة الوحيدة المتاحة لتنفيذ أوامر bash حقيقية (curl لجلب الروابط، cat لكتابة الملفات، node لتشغيل الفحص والرندر، ffmpeg للدمج، و gh لإدارة الـ Release والرفع).',
    parameters: {
      type: 'OBJECT',
      properties: { command: { type: 'STRING', description: 'أمر bash كامل للتنفيذ داخل بيئة التشغيل' } },
      required: ['command'],
    },
  },
];

// ---------------------------------------------------------------------------
// محرك الاتصال الذكي بـ Gemini API مع تدوير المفاتيح والتبديل التلقائي للنماذج
// ---------------------------------------------------------------------------
function parseRetryDelaySeconds(errorBody) {
  try {
    const details = errorBody && errorBody.error && errorBody.error.details;
    const retryInfo = details && details.find((d) => (d['@type'] || '').includes('RetryInfo'));
    if (!retryInfo || !retryInfo.retryDelay) return null;
    const seconds = parseFloat(String(retryInfo.retryDelay).replace('s', ''));
    return Number.isFinite(seconds) ? seconds : null;
  } catch (e) {
    return null;
  }
}

async function callGemini(contents, systemInstruction, attempt = 1, keyRotationsTried = 0) {
  const MAX_ATTEMPTS_PER_MODEL = 3;
  const model = MODEL_CHAIN[currentModelIndex];
  const apiKey = GEMINI_API_KEYS[currentKeyIndex];
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const body = {
    contents,
    system_instruction: { parts: [{ text: systemInstruction }] },
    tools: [{ functionDeclarations }],
  };

  let res, data;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    });
    data = await res.json();
  } catch (networkErr) {
    if (attempt < MAX_ATTEMPTS_PER_MODEL) {
      const waitSeconds = Math.min(60, 5 * Math.pow(2, attempt));
      log(`خطأ شبكة عند الاتصال بـ Gemini (${networkErr.message}). الانتظار ${waitSeconds}s وإعادة المحاولة (${attempt}/${MAX_ATTEMPTS_PER_MODEL})...`);
      await new Promise((r) => setTimeout(r, waitSeconds * 1000));
      return callGemini(contents, systemInstruction, attempt + 1, keyRotationsTried);
    }
    throw new Error(`فشل الاتصال بـ Gemini بعد عدة محاولات: ${networkErr.message}`);
  }

  if (!res.ok) {
    const isRateLimit = res.status === 429;
    const isTransient = isRateLimit || (res.status >= 500 && res.status < 600);

    if (isTransient) {
      // تدوير فوري للمفاتيح عند خطأ الـ 429
      if (isRateLimit && keyRotationsTried < GEMINI_API_KEYS.length - 1) {
        currentKeyIndex = (currentKeyIndex + 1) % GEMINI_API_KEYS.length;
        log(`تنبيه (429) على ${model}. التبديل الفوري لمفتاح API رقم ${currentKeyIndex + 1}/${GEMINI_API_KEYS.length}...`);
        return callGemini(contents, systemInstruction, attempt, keyRotationsTried + 1);
      }

      if (attempt < MAX_ATTEMPTS_PER_MODEL) {
        const serverDelay = parseRetryDelaySeconds(data);
        const waitSeconds = serverDelay != null ? serverDelay + 1 : Math.min(60, 5 * Math.pow(2, attempt));
        log(`خطأ مؤقت (${res.status}) على ${model}. الانتظار ${waitSeconds.toFixed(1)}s وإعادة المحاولة (${attempt}/${MAX_ATTEMPTS_PER_MODEL})...`);
        await new Promise((r) => setTimeout(r, waitSeconds * 1000));
        return callGemini(contents, systemInstruction, attempt + 1, 0);
      }

      // التبديل للنموذج الاحتياطي التالي
      if (currentModelIndex < MODEL_CHAIN.length - 1) {
        currentModelIndex++;
        log(`استنفاد محاولات ${model} (${res.status}). التبديل للنموذج الاحتياطي: ${MODEL_CHAIN[currentModelIndex]}`);
        return callGemini(contents, systemInstruction, 1, 0);
      }

      throw new Error(`استنفدت كافة النماذج في السلسلة (${MODEL_CHAIN.join(', ')}) بسبب الأخطاء (${res.status}).`);
    }
    throw new Error(`Gemini API error (${res.status}): ${JSON.stringify(data).slice(0, 500)}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// بناء الـ System Prompt الشامل
// ---------------------------------------------------------------------------
function buildSystemPrompt(agentsMd) {
  return `
أنت أوفق AI Agent — المحرك التنفيذي الذكي المسؤول عن استقبال المشاهد، رندرتها، دمجها، ورفعها بالكامل.

# دليل التنفيذ والعقد المعماري الإلزامي (AGENTS.md):
${agentsMd}

# الأداة المتاحة لك:
run_terminal(command) — من خلالها تنفّذ كافة خطواتك البرمجية بنفسك عبر التيرمينال:
1. **استقبال المشاهد بمختلف الأنماط**:
   - إذا كان كود HTML منسوخاً: احفظه في \`scene.html\`.
   - إذا كان رابط Raw واحداً: اجلبه بأمر \`curl -fsSL "<URL>" -o scene.html\`.
   - إذا كانت روابط Raw متعددة: رندر كل مشهد (\`part_1.mp4\`, \`part_2.mp4\`...) ثم ادمجها عبر قائمة \`concat_list.txt\` وأمر \`ffmpeg -f concat -safe 0 -i concat_list.txt -c copy final_merged_video.mp4\`.
   - إذا كان بناءً من ملف هوية في \`identities/\`: اقرأ الملف واكتب الكود بالكامل.
2. **فحص الجاهزية**: اكتب وشغّل \`_headless_check.js\` للتأكد من خلو الكود من الأخطاء وطباعة \`SCENE_OK\`.
3. **الرندر**: اكتب وشغّل \`render-runner.js\` لاستخراج الفيديو.
4. **إدارة الـ Release والرفع**:
   - أنشئ الـ Release بنفسك وسمّه بما يناسب المهمة: \`gh release create <tag_name> --repo "$GH_REPO" --title "..." --notes "..."\`
   - ارفع ملفات الفيديو والأوصاف وأكواد المشاهد: \`gh release upload <tag_name> <files> --repo "$GH_REPO" --clobber\`
5. **إنهاء المهمة**: اكتب ملف \`TASK_COMPLETE.json\` يحتوي على ملخص ما تم وروابط الأصول المرفوعة.

# معمارية التفكير والإنجاز:
1. **Plan-and-Solve**: الرد الأول منك يجب أن يكون **نصاً عادياً** (خطة العمل وخطواتك بالتفصيل بدون استدعاء run_terminal).
2. **التنفيذ**: استمر في تنفيذ خطواتك عبر run_terminal حتى اكتمال كل المهام وإنشاء \`TASK_COMPLETE.json\`.

# بيئة التشغيل:
- الريبو: $GH_REPO (${GH_REPO})
- الأدوات المتاحة: curl, gh, node, ffmpeg, npm

# المهمة المطلوبة منك الآن:
${TASK_JSON}
`.trim();
}

// ---------------------------------------------------------------------------
// حلقة عمل الـ Agent (Execution Loop)
// ---------------------------------------------------------------------------
async function runAgentLoop() {
  const agentsMd = fs.readFileSync(path.join(WORK_DIR, 'AGENTS.md'), 'utf-8');
  const systemInstruction = buildSystemPrompt(agentsMd);

  let contents = [{ role: 'user', parts: [{ text: 'ابدأ المهمة. اكتب خطتك الكاملة كنص عادي أولاً.' }] }];
  let hasPlanned = false;
  let taskComplete = false;
  let finalPayload = null;

  for (let turn = 0; turn < MAX_TURNS && !taskComplete; turn++) {
    log(`--- Turn ${turn + 1}/${MAX_TURNS} ---`);
    const response = await callGemini(contents, systemInstruction);
    const candidate = response.candidates && response.candidates[0];
    if (!candidate) throw new Error('لم يصل أي رد من Gemini: ' + JSON.stringify(response).slice(0, 500));

    contents.push(candidate.content);
    const parts = candidate.content.parts || [];
    const functionCalls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);

    if (functionCalls.length === 0) {
      const textReply = parts.map((p) => p.text || '').join(' ');
      log('رد نصي (خطة / مراجعة): ' + textReply);
      hasPlanned = true;
      contents.push({ role: 'user', parts: [{ text: 'تمام، استمر في تنفيذ خطواتك عبر أوامر run_terminal.' }] });
      continue;
    }

    const functionResponses = [];
    for (const fc of functionCalls) {
      log(`run_terminal: ${JSON.stringify(fc.args)}`);

      let result;
      if (!hasPlanned) {
        result = { success: false, error: 'يجب كتابة خطة العمل كنص عادي أولاً قبل تنفيذ أي أمر terminal.' };
      } else {
        result = await runTerminal(fc.args || {});
      }

      log(`نتيجة: ${JSON.stringify(result)}`);
      functionResponses.push({ functionResponse: { name: fc.name, response: result, id: fc.id } });
    }

    contents.push({ role: 'user', parts: functionResponses });

    // فحص اكتمال المهمة عبر ملف TASK_COMPLETE.json
    if (fs.existsSync(path.join(WORK_DIR, TASK_COMPLETE_MARKER))) {
      try {
        finalPayload = JSON.parse(fs.readFileSync(path.join(WORK_DIR, TASK_COMPLETE_MARKER), 'utf-8'));
        taskComplete = true;
        log('✅ اكتملت المهمة بنجاح وتم إنشاء ملف TASK_COMPLETE.json.');
      } catch (e) {
        log('ملاحظة: جاري استكمال كتابة TASK_COMPLETE.json...');
      }
    }
  }

  if (!taskComplete) {
    throw new Error(`وصلنا للحد الأقصى من الأدوار (${MAX_TURNS}) دون إتمام ${TASK_COMPLETE_MARKER}.`);
  }
  return finalPayload;
}

// ============================================================================
// دالة التشغيل الرئيسية
// ============================================================================
async function main() {
  if (GEMINI_API_KEYS.length === 0) {
    console.error('مفاتيح GEMINI_API_KEY غير معرّفة في متغيرات البيئة. توقف التنفيذ.');
    process.exit(1);
  }

  log('بسم الله — بدء تشغيل أوفق AI Agent v3.0');

  let finalPayload = null;
  try {
    finalPayload = await runAgentLoop();
    log('النتيجة النهائية: ' + JSON.stringify(finalPayload, null, 2));
  } catch (err) {
    log('فشل تنفيذ المهمة: ' + err.message);
    throw err;
  }

  if (CALLBACK_URL) {
    try {
      await fetch(CALLBACK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(finalPayload),
      });
      log('تم إرسال إشعار الـ callback بنجاح.');
    } catch (e) {
      log('تحذير: تعذر الاتصال بـ callback endpoint: ' + e.message);
    }
  }
}

main().catch((err) => {
  console.error('خطأ فادح في تشغيل الـ Agent:', err);
  process.exit(1);
});
