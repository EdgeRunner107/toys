require("dotenv").config();

const express = require("express");
const cors = require("cors");
const WebSocket = require("ws");
const { createClient } = require("@supabase/supabase-js");

const app = express();

/* =========================================================
   환경변수
========================================================= */

const PORT = Number(process.env.PORT) || 8888;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

/* =========================================================
   필수 환경변수 검사
========================================================= */

if (!SUPABASE_URL) {
  console.error("❌ SUPABASE_URL 환경변수가 없습니다.");
  process.exit(1);
}

if (!SUPABASE_SECRET_KEY) {
  console.error("❌ SUPABASE_SECRET_KEY 환경변수가 없습니다.");
  process.exit(1);
}

/* =========================================================
   Supabase 연결
========================================================= */

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SECRET_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },

    // Node.js 20 WebSocket 오류 방지
    realtime: {
      transport: WebSocket,
    },
  }
);

/* =========================================================
   Express 기본 설정
========================================================= */

app.set("trust proxy", 1);

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(
  express.json({
    limit: "10mb",
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "10mb",
  })
);

/* =========================================================
   문자열 정리 함수
========================================================= */

function cleanText(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

/* =========================================================
   은행명 여부 확인
========================================================= */

function isBankName(value) {
  const bankNames = [
    "기업",
    "IBK기업",
    "국민",
    "KB국민",
    "신한",
    "하나",
    "우리",
    "농협",
    "NH농협",
    "카카오뱅크",
    "토스뱅크",
    "케이뱅크",
    "새마을",
    "새마을금고",
    "신협",
    "수협",
    "우체국",
    "SC제일",
    "씨티",
    "부산",
    "대구",
    "광주",
    "전북",
    "경남",
    "제주",
    "산업",
  ];

  return bankNames.some(
    (bankName) =>
      value.trim().toLowerCase() === bankName.toLowerCase()
  );
}

/* =========================================================
   계좌번호처럼 보이는 문자열 확인
========================================================= */

function looksLikeAccountNumber(value) {
  const normalized = value.replace(/\s/g, "");

  /*
   * 다음 형식을 계좌번호로 판단합니다.
   *
   * 666***58901011
   * 123-456-789012
   * 123456789012
   */
  return (
    /^[0-9*]+$/.test(normalized) &&
    normalized.length >= 6
  ) || /^[0-9*-]{6,}$/.test(normalized);
}

/* =========================================================
   시스템 줄 여부 확인
========================================================= */

function isSystemLine(value) {
  const line = value.trim();

  if (!line) {
    return true;
  }

  // [Web발신], [국제발신] 등
  if (/^\[.*발신.*\]$/i.test(line)) {
    return true;
  }

  // 날짜와 시간
  if (
    /^\d{4}[./-]\d{1,2}[./-]\d{1,2}\s+\d{1,2}:\d{2}/.test(
      line
    )
  ) {
    return true;
  }

  // 입금 금액 줄
  if (/^입금\s*[:：]?\s*[\d,\s]+\s*원/i.test(line)) {
    return true;
  }

  // 잔액 줄
  if (/^잔액\s*[:：]?\s*[\d,\s]+\s*원/i.test(line)) {
    return true;
  }

  // 출금 줄
  if (/^출금\s*[:：]?\s*[\d,\s]+\s*원/i.test(line)) {
    return true;
  }

  return false;
}

/* =========================================================
   입금 SMS 파싱 함수
========================================================= */

/**
 * 입력 예시:
 *
 * [Web발신]
 * 2026/07/27 04:52
 * 입금 10,000원
 * 잔액 45,645원
 * 지니/문어플
 * 666***58901011
 * 기업
 *
 * 반환 결과:
 *
 * {
 *   depositAmount: 10000,
 *   depositText: "지니/문어플"
 * }
 */
function parseDepositMessage(inputText) {
  const rawText = cleanText(inputText);

  const result = {
    depositAmount: null,
    depositText: null,
  };

  if (!rawText) {
    return result;
  }

  const lines = rawText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  /* ---------------------------------------------------------
     1. 입금금액 추출
  --------------------------------------------------------- */

  /*
   * 처리 가능한 형식:
   *
   * 입금 100원
   * 입금 10,000원
   * 입금10,000원
   * 입금: 10,000원
   * 입금：10,000 원
   * 입금 1 000 원
   */
  const amountMatch = rawText.match(
    /(?:^|\n)\s*입금\s*[:：]?\s*([0-9][0-9,\s]*)\s*원/imu
  );

  if (amountMatch) {
    const amountString = amountMatch[1].replace(
      /[,\s]/g,
      ""
    );

    const parsedAmount = Number(amountString);

    if (
      Number.isSafeInteger(parsedAmount) &&
      parsedAmount >= 0
    ) {
      result.depositAmount = parsedAmount;
    }
  }

  /* ---------------------------------------------------------
     2. "잔액" 다음 줄에서 입금 텍스트 추출
  --------------------------------------------------------- */

  const balanceIndex = lines.findIndex((line) =>
    /^잔액\s*[:：]?\s*/i.test(line)
  );

  if (balanceIndex !== -1) {
    for (
      let index = balanceIndex + 1;
      index < lines.length;
      index += 1
    ) {
      const candidate = lines[index].trim();

      if (!candidate) {
        continue;
      }

      if (isSystemLine(candidate)) {
        continue;
      }

      if (looksLikeAccountNumber(candidate)) {
        continue;
      }

      if (isBankName(candidate)) {
        continue;
      }

      result.depositText = candidate;
      break;
    }
  }

  /* ---------------------------------------------------------
     3. 잔액 줄을 찾지 못했을 때 보조 검색
  --------------------------------------------------------- */

  if (!result.depositText) {
    const depositIndex = lines.findIndex((line) =>
      /^입금\s*[:：]?\s*/i.test(line)
    );

    const searchStartIndex =
      depositIndex !== -1 ? depositIndex + 1 : 0;

    for (
      let index = searchStartIndex;
      index < lines.length;
      index += 1
    ) {
      const candidate = lines[index].trim();

      if (!candidate) {
        continue;
      }

      if (isSystemLine(candidate)) {
        continue;
      }

      if (looksLikeAccountNumber(candidate)) {
        continue;
      }

      if (isBankName(candidate)) {
        continue;
      }

      result.depositText = candidate;
      break;
    }
  }

  return result;
}

/* =========================================================
   클라이언트 IP 확인
========================================================= */

function getClientIp(req) {
  const forwardedFor = req.get("x-forwarded-for");

  if (forwardedFor) {
    return forwardedFor.split(",")[0].trim();
  }

  return (
    req.ip ||
    req.socket?.remoteAddress ||
    null
  );
}

/* =========================================================
   루트 페이지
========================================================= */

app.get("/", (req, res) => {
  return res.status(200).json({
    success: true,
    message: "ACserver 웹훅 서버가 정상 실행 중입니다.",
    webhook: {
      method: "POST",
      url: "/webhook",
    },
    serverTime: new Date().toISOString(),
  });
});

/* =========================================================
   서버 및 Supabase 연결 확인
========================================================= */

app.get("/health", async (req, res) => {
  try {
    const { error } = await supabase
      .from("webhook_logs")
      .select("id")
      .limit(1);

    if (error) {
      throw error;
    }

    return res.status(200).json({
      success: true,
      server: "online",
      database: "connected",
      serverTime: new Date().toISOString(),
    });
  } catch (error) {
    console.error("❌ Supabase 연결 확인 실패:", error);

    return res.status(500).json({
      success: false,
      server: "online",
      database: "disconnected",
      message: error.message,
    });
  }
});

/* =========================================================
   파싱 테스트 API
========================================================= */

/**
 * DB에 저장하지 않고 파싱 결과만 확인합니다.
 *
 * POST /parse-test
 *
 * 요청:
 * {
 *   "text": "[Web발신]\n..."
 * }
 */
app.post("/parse-test", (req, res) => {
  const rawText = req.body?.text;
  const parsed = parseDepositMessage(rawText);

  return res.status(200).json({
    success: true,
    originalText: rawText || null,
    depositAmount: parsed.depositAmount,
    depositText: parsed.depositText,
  });
});

/* =========================================================
   웹훅 수신 및 Supabase 저장
========================================================= */

/**
 * POST /webhook
 *
 * 요청 예시:
 *
 * {
 *   "text": "[Web발신]\n2026/07/27 04:52\n입금 10,000원\n잔액 45,645원\n지니/문어플\n666***58901011\n기업"
 * }
 */
app.post("/webhook", async (req, res) => {
  try {
    const payload = req.body;

    /* -------------------------------------------------------
       요청 본문 유효성 검사
    ------------------------------------------------------- */

    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    ) {
      return res.status(400).json({
        success: false,
        message: "요청 본문은 JSON 객체여야 합니다.",
      });
    }

    const rawText = cleanText(payload.text);

    if (!rawText) {
      return res.status(400).json({
        success: false,
        message: "요청 본문에 text 값이 없습니다.",
        receivedBody: payload,
      });
    }

    /* -------------------------------------------------------
       입금금액과 입금 텍스트 추출
    ------------------------------------------------------- */

    const parsed = parseDepositMessage(rawText);

    const depositAmount = parsed.depositAmount;
    const depositText = parsed.depositText;

    /* -------------------------------------------------------
       입금금액 검증
    ------------------------------------------------------- */

    if (depositAmount === null) {
      return res.status(400).json({
        success: false,
        message:
          "문자 내용에서 입금금액을 찾지 못했습니다.",
        parsed: {
          depositAmount,
          depositText,
        },
      });
    }

    /*
     * 필요에 따라 범위를 조절할 수 있습니다.
     * 현재 1원 이상만 저장합니다.
     */
    if (depositAmount < 1) {
      return res.status(400).json({
        success: false,
        message: "입금금액은 1원 이상이어야 합니다.",
        parsed: {
          depositAmount,
          depositText,
        },
      });
    }

    /* -------------------------------------------------------
       입금 텍스트 검증
    ------------------------------------------------------- */

    if (!depositText) {
      return res.status(400).json({
        success: false,
        message:
          "문자 내용에서 입금 텍스트를 찾지 못했습니다.",
        parsed: {
          depositAmount,
          depositText,
        },
      });
    }

    /*
     * 지나치게 긴 텍스트가 저장되는 것을 방지합니다.
     */
    if (depositText.length > 500) {
      return res.status(400).json({
        success: false,
        message:
          "입금 텍스트가 너무 깁니다. 최대 500자까지 허용합니다.",
      });
    }

    /* -------------------------------------------------------
       저장할 부가정보 생성
    ------------------------------------------------------- */

    const eventType =
      payload.type ||
      payload.event ||
      payload.event_type ||
      "bank_deposit";

    const requestHeaders = {
      "content-type":
        req.get("content-type") || null,
      "user-agent":
        req.get("user-agent") || null,
      "x-forwarded-for":
        req.get("x-forwarded-for") || null,
    };

    const senderIp = getClientIp(req);

    /* -------------------------------------------------------
       Supabase 저장
    ------------------------------------------------------- */

    const { data, error } = await supabase
      .from("webhook_logs")
      .insert([
        {
          event_type: String(eventType),

          // 웹훅으로 받은 원본 JSON
          payload,

          // 예: 10000
          deposit_amount: depositAmount,

          // 예: 지니/문어플
          deposit_text: depositText,

          request_headers: requestHeaders,
          sender_ip: senderIp,
          processed: false,
        },
      ])
      .select()
      .single();

    if (error) {
      console.error("❌ Supabase 저장 오류:", error);

      return res.status(500).json({
        success: false,
        message: "Supabase 저장에 실패했습니다.",
        error: error.message,
        details: error.details || null,
        hint: error.hint || null,
        code: error.code || null,
      });
    }

    console.log("✅ 입금 데이터 저장 완료:", {
      id: data.id,
      depositAmount: data.deposit_amount,
      depositText: data.deposit_text,
      createdAt: data.created_at,
    });

    return res.status(201).json({
      success: true,
      message: "입금 데이터를 저장했습니다.",
      data: {
        id: data.id,
        depositAmount: data.deposit_amount,
        depositText: data.deposit_text,
        processed: data.processed,
        createdAt: data.created_at,
      },
    });
  } catch (error) {
    console.error(
      "❌ 웹훅 처리 중 예상하지 못한 오류:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "서버 내부 오류가 발생했습니다.",
      error: error.message,
    });
  }
});

/* =========================================================
   저장된 웹훅 목록 조회
========================================================= */

/**
 * GET /webhook-logs
 * GET /webhook-logs?limit=20
 * GET /webhook-logs?processed=false
 */
app.get("/webhook-logs", async (req, res) => {
  try {
    const requestedLimit = Number(req.query.limit) || 50;

    const limit = Math.min(
      Math.max(
        Number.isFinite(requestedLimit)
          ? requestedLimit
          : 50,
        1
      ),
      500
    );

    let query = supabase
      .from("webhook_logs")
      .select("*")
      .order("created_at", {
        ascending: false,
      })
      .limit(limit);

    /*
     * processed=true 또는 processed=false 필터
     */
    if (req.query.processed === "true") {
      query = query.eq("processed", true);
    } else if (req.query.processed === "false") {
      query = query.eq("processed", false);
    }

    const { data, error } = await query;

    if (error) {
      throw error;
    }

    return res.status(200).json({
      success: true,
      count: data.length,
      data,
    });
  } catch (error) {
    console.error("❌ 웹훅 목록 조회 오류:", error);

    return res.status(500).json({
      success: false,
      message: "웹훅 목록 조회에 실패했습니다.",
      error: error.message,
    });
  }
});

/* =========================================================
   특정 웹훅 조회
========================================================= */

/**
 * GET /webhook-logs/1
 */
app.get("/webhook-logs/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "올바른 ID가 아닙니다.",
      });
    }

    const { data, error } = await supabase
      .from("webhook_logs")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) {
      return res.status(404).json({
        success: false,
        message: "해당 데이터를 찾을 수 없습니다.",
      });
    }

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("❌ 웹훅 상세 조회 오류:", error);

    return res.status(500).json({
      success: false,
      message: "웹훅 상세 조회에 실패했습니다.",
      error: error.message,
    });
  }
});

/* =========================================================
   처리 상태 변경
========================================================= */

/**
 * PATCH /webhook-logs/1/processed
 *
 * 요청:
 * {
 *   "processed": true
 * }
 */
app.patch(
  "/webhook-logs/:id/processed",
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      const processed = req.body?.processed;

      if (!Number.isSafeInteger(id) || id <= 0) {
        return res.status(400).json({
          success: false,
          message: "올바른 ID가 아닙니다.",
        });
      }

      if (typeof processed !== "boolean") {
        return res.status(400).json({
          success: false,
          message:
            "processed 값은 true 또는 false여야 합니다.",
        });
      }

      const { data, error } = await supabase
        .from("webhook_logs")
        .update({
          processed,
        })
        .eq("id", id)
        .select()
        .maybeSingle();

      if (error) {
        throw error;
      }

      if (!data) {
        return res.status(404).json({
          success: false,
          message: "해당 데이터를 찾을 수 없습니다.",
        });
      }

      return res.status(200).json({
        success: true,
        message: "처리 상태를 변경했습니다.",
        data,
      });
    } catch (error) {
      console.error("❌ 처리 상태 변경 오류:", error);

      return res.status(500).json({
        success: false,
        message: "처리 상태 변경에 실패했습니다.",
        error: error.message,
      });
    }
  }
);

/* =========================================================
   존재하지 않는 주소 처리
========================================================= */

app.use((req, res) => {
  return res.status(404).json({
    success: false,
    message: "존재하지 않는 API 주소입니다.",
    method: req.method,
    path: req.originalUrl,
  });
});

/* =========================================================
   Express 전역 오류 처리
========================================================= */

app.use((error, req, res, next) => {
  console.error("❌ Express 전역 오류:", error);

  /*
   * JSON 형식이 잘못된 경우
   */
  if (
    error instanceof SyntaxError &&
    error.status === 400 &&
    "body" in error
  ) {
    return res.status(400).json({
      success: false,
      message: "올바른 JSON 형식이 아닙니다.",
    });
  }

  return res.status(500).json({
    success: false,
    message: "서버 오류가 발생했습니다.",
    error: error.message,
  });
});

/* =========================================================
   로컬 서버 실행
========================================================= */

/*
 * Vercel에서는 app.listen()이 필수는 아니지만,
 * 로컬 실행을 위해 유지합니다.
 */
if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log("-----------------------------------------");
    console.log("✅ ACserver 실행 완료");
    console.log(`✅ 로컬 주소: http://localhost:${PORT}`);
    console.log(
      `✅ 웹훅 주소: http://localhost:${PORT}/webhook`
    );
    console.log(
      `✅ 파싱 테스트: http://localhost:${PORT}/parse-test`
    );
    console.log(
      `✅ 상태 확인: http://localhost:${PORT}/health`
    );
    console.log("-----------------------------------------");
  });
}

/*
 * Vercel Serverless Function에서 Express 앱을 사용하기 위해
 * app 객체를 내보냅니다.
 */
module.exports = app;
