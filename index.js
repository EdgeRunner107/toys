require("dotenv").config();

const express = require("express");
const cors = require("cors");
const WebSocket = require("ws");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");
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
   Weflab 데이터 설정
========================================================= */

const WEFLAB_INSERT_BATCH_SIZE = 500;
const WEFLAB_DEFAULT_PAGE_SIZE = 500;
const WEFLAB_MAX_PAGE_SIZE = 1000;


/* =========================================================
   Weflab 닉네임 파싱
========================================================= */

function parseWeflabNickname(value) {
  if (value === null || value === undefined) {
    return "";
  }

  let text = String(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();

  if (!text) {
    return "";
  }

  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  /*
   * 예:
   *
   * 근이는하리★
   * (ldgcd)
   *
   * ↓
   *
   * 근이는하리★
   */
  if (lines.length >= 2) {
    const lastLine =
      lines[lines.length - 1];

    if (/^\([^()]+\)$/.test(lastLine)) {
      return lines
        .slice(0, -1)
        .join(" ")
        .trim();
    }
  }

  /*
   * 줄바꿈 없이
   *
   * 근이는하리★ (ldgcd)
   *
   * 형태로 들어온 경우
   */
  return text
    .replace(/\s*\([^()]+\)\s*$/, "")
    .trim();
}


/* =========================================================
   Weflab 숫자 변환
========================================================= */

function parseWeflabAmount(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  if (
    typeof value === "number" &&
    Number.isFinite(value)
  ) {
    const parsed =
      Math.trunc(value);

    return Number.isSafeInteger(parsed)
      ? parsed
      : null;
  }

  const text =
    String(value).trim();

  if (!text) {
    return null;
  }

  /*
   * 구독:
   *
   * 1개월
   *
   * 은 점수 숫자로 저장하지 않음
   */
  if (/^\d+\s*개월$/i.test(text)) {
    return null;
  }

  const match =
    text.match(/-?\d[\d,]*/);

  if (!match) {
    return null;
  }

  const parsed =
    Number(
      match[0].replace(/,/g, "")
    );

  if (!Number.isSafeInteger(parsed)) {
    return null;
  }

  return parsed;
}


/* =========================================================
   마지막 숫자 찾기
========================================================= */

function extractLastWeflabNumber(row) {
  /*
   * 먼저 자주 사용할 컬럼명 확인
   */
  const knownKeys = [
    "amount",
    "score",
    "last_number",
    "lastNumber",
    "마지막숫자",
    "마지막 숫자",
    "점수",
    "후원수",
  ];

  for (const key of knownKeys) {
    if (
      Object.prototype.hasOwnProperty.call(
        row,
        key
      )
    ) {
      const amount =
        parseWeflabAmount(
          row[key]
        );

      if (amount !== null) {
        return amount;
      }
    }
  }


  /*
   * 컬럼명이 애매한 경우
   * 객체 맨 마지막부터 숫자를 찾음
   */
  const entries =
    Object.entries(row);

  for (
    let index = entries.length - 1;
    index >= 0;
    index -= 1
  ) {
    const [key, value] =
      entries[index];

    /*
     * 아래 컬럼들은 마지막 숫자 탐색에서 제외
     */
    if (
      key === "시간" ||
      key === "time" ||
      key === "event_time" ||
      key === "후원,구독" ||
      key === "후원" ||
      key === "donation"
    ) {
      continue;
    }


    if (
      typeof value === "number" &&
      Number.isFinite(value)
    ) {
      const parsed =
        Math.trunc(value);

      if (
        Number.isSafeInteger(parsed)
      ) {
        return parsed;
      }
    }


    /*
     * 문자열인데 순수 숫자인 경우
     *
     * "1,169"
     * "1169"
     */
    if (
      typeof value === "string" &&
      /^-?[\d,]+$/.test(
        value.trim()
      )
    ) {
      const amount =
        parseWeflabAmount(value);

      if (amount !== null) {
        return amount;
      }
    }
  }

  return null;
}


/* =========================================================
   시간 정리
========================================================= */

function normalizeWeflabEventTime(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  const text =
    String(value).trim();

  if (!text) {
    return null;
  }

  /*
   * 예:
   * 2026-03-27 16:26:30
   */
  const match =
    text.match(
      /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/
    );

  if (!match) {
    return text;
  }

  const seconds =
    match[6] || "00";

  return (
    `${match[1]}-${match[2]}-${match[3]} ` +
    `${match[4]}:${match[5]}:${seconds}`
  );
}


/* =========================================================
   중복 방지 키 생성
========================================================= */

function createWeflabDedupeKey({
  eventTime,
  nickname,
  text,
  amount,
}) {
  const normalized =
    JSON.stringify([
      eventTime || "",
      nickname || "",
      text || "",
      amount === null ||
      amount === undefined
        ? ""
        : String(amount),
    ]);

  return crypto
    .createHash("sha256")
    .update(
      normalized,
      "utf8"
    )
    .digest("hex");
}


/* =========================================================
   Weflab 한 행 변환
========================================================= */

function parseWeflabRow(row) {
  if (
    !row ||
    typeof row !== "object" ||
    Array.isArray(row)
  ) {
    return {
      valid: false,
      reason: "객체 형식이 아닙니다.",
      data: null,
    };
  }


  /* 시간 */

  const eventTime =
    normalizeWeflabEventTime(
      row["시간"] ??
      row.time ??
      row.event_time ??
      row.datetime ??
      null
    );


  /* 닉네임 */

  const originalName =
    row["이름"] ??
    row.nickname ??
    row.name ??
    "";

  const nickname =
    parseWeflabNickname(
      originalName
    );


  /* 채팅 */

  const chatValue =
    row["채팅"] ??
    row.text ??
    row.chat ??
    row.message ??
    null;

  const text =
    chatValue === null ||
    chatValue === undefined
      ? null
      : String(chatValue).trim();


  /* 마지막 숫자 */

  const amount =
    extractLastWeflabNumber(
      row
    );


  if (!eventTime) {
    return {
      valid: false,
      reason: "시간이 없습니다.",
      data: null,
    };
  }


  if (!nickname) {
    return {
      valid: false,
      reason: "닉네임이 없습니다.",
      data: null,
    };
  }


  const dedupeKey =
    createWeflabDedupeKey({
      eventTime,
      nickname,
      text,
      amount,
    });


  return {
    valid: true,

    data: {
      event_time: eventTime,
      nickname,
      text,
      amount,
      dedupe_key: dedupeKey,
    },
  };
}


/* =========================================================
   배열 500개씩 나누기
========================================================= */

function chunkArray(items, size) {
  const chunks = [];

  for (
    let index = 0;
    index < items.length;
    index += size
  ) {
    chunks.push(
      items.slice(
        index,
        index + size
      )
    );
  }

  return chunks;
}
















/* ======================================
===================
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
               payload,
               deposit_amount: depositAmount,
               deposit_text: depositText,
         
               // 시그 실행 여부
               signature_executed: false,
         
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
   Weflab 공통 함수
========================================================= */

/**
 * 회차 추출
 *
 * 지원:
 * {
 *   round: "ARTS1회차"
 * }
 *
 * {
 *   회차: "ARTS1회차"
 * }
 *
 * {
 *   회차명: "ARTS1회차"
 * }
 *
 * 엑셀 마지막 컬럼에 ARTS1회차가 있을 경우도 보조적으로 탐색
 */
function extractWeflabRound(row) {
  if (
    !row ||
    typeof row !== "object"
  ) {
    return "";
  }


  /* ---------------------------------------
     명시적인 컬럼명 우선
  --------------------------------------- */

  const candidates = [
    row.round,
    row["회차"],
    row["회차명"],
    row.round_name,
    row.roundName,
  ];


  for (const value of candidates) {
    if (
      value !== null &&
      value !== undefined &&
      String(value).trim()
    ) {
      return String(value).trim();
    }
  }


  /* ---------------------------------------
     마지막 컬럼 보조 탐색

     예:
     ARTS1회차
     로벤저스1회차
     1회차
  --------------------------------------- */

  const values =
    Object.values(row);


  for (
    let i = values.length - 1;
    i >= 0;
    i -= 1
  ) {
    const value =
      values[i];


    if (
      value === null ||
      value === undefined
    ) {
      continue;
    }


    const text =
      String(value).trim();


    if (!text) {
      continue;
    }


    if (
      text.includes("회차")
    ) {
      return text;
    }
  }


  return "";
}


/* =========================================================
   Weflab 데이터 저장 API
========================================================= */

/*
 * POST /weflab-data
 *
 * 지원:
 *
 * [
 *   {...},
 *   {...}
 * ]
 *
 * 또는
 *
 * {
 *   "data": [...]
 * }
 *
 *
 * 예:
 *
 * {
 *   "시간": "2026-03-27 16:26:30",
 *   "이름": "근이는하리★<br>(ldgcd)",
 *   "후원,구독": "1,015개",
 *   "채팅": "달리",
 *   "멤버": "달리",
 *   "마지막숫자": 1015,
 *   "회차": "ARTS1회차"
 * }
 */

app.post(
  "/weflab-data",
  async (req, res) => {

    try {

      const body =
        req.body;


      let rows = [];


      /* ---------------------------------------
         요청 데이터 형식 확인
      --------------------------------------- */

      if (
        Array.isArray(body)
      ) {

        rows =
          body;

      }

      else if (
        body &&
        Array.isArray(
          body.data
        )
      ) {

        rows =
          body.data;

      }

      else if (
        body &&
        typeof body === "object"
      ) {

        rows = [
          body
        ];

      }

      else {

        return res
          .status(400)
          .json({
            success: false,

            message:
              "JSON 객체 또는 배열을 보내주세요.",
          });

      }


      if (
        rows.length === 0
      ) {

        return res
          .status(400)
          .json({
            success: false,

            message:
              "저장할 데이터가 없습니다.",
          });

      }


      /* ---------------------------------------
         데이터 변환
      --------------------------------------- */

      const parsedRows = [];

      const skippedRows = [];


      for (
        let index = 0;
        index < rows.length;
        index += 1
      ) {

        const sourceRow =
          rows[index];


        /*
         * 기존 Weflab 파싱 함수
         *
         * 반환 예:
         *
         * {
         *   valid: true,
         *   data: {
         *     event_time,
         *     nickname,
         *     text,
         *     amount,
         *     dedupe_key
         *   }
         * }
         */

        const result =
          parseWeflabRow(
            sourceRow
          );


        if (
          !result.valid
        ) {

          skippedRows.push({
            index,

            reason:
              result.reason,
          });

          continue;

        }


        /* ---------------------------------------
           회차 추출
        --------------------------------------- */

        const round =
          extractWeflabRound(
            sourceRow
          );


        if (!round) {

          skippedRows.push({
            index,

            reason:
              "회차 정보가 없습니다.",
          });

          continue;

        }


        /* ---------------------------------------
           저장 데이터 생성
        --------------------------------------- */

        const parsedData = {
          ...result.data,

          round,
        };


        /*
         * 기존 dedupe_key는
         *
         * 시간 + 닉네임 + 채팅 + 금액
         *
         * 기반이므로 다른 회차에서 똑같은 후원이
         * 발생하면 중복으로 처리될 수 있습니다.
         *
         * 따라서 회차를 dedupe_key 앞에 추가합니다.
         */

        parsedData.dedupe_key =
          `${round}|${result.data.dedupe_key}`;


        parsedRows.push(
          parsedData
        );

      }


      if (
        parsedRows.length === 0
      ) {

        return res
          .status(400)
          .json({
            success: false,

            message:
              "저장 가능한 데이터가 없습니다.",

            received:
              rows.length,

            skipped:
              skippedRows.length,

            skippedRows,
          });

      }


      /* ---------------------------------------
         요청 내부 중복 제거
      --------------------------------------- */

      const uniqueMap =
        new Map();


      for (
        const row of parsedRows
      ) {

        uniqueMap.set(
          row.dedupe_key,
          row
        );

      }


      const uniqueRows =
        Array.from(
          uniqueMap.values()
        );


      /* ---------------------------------------
         500개씩 분할
      --------------------------------------- */

      const batches =
        chunkArray(
          uniqueRows,
          WEFLAB_INSERT_BATCH_SIZE
        );


      let processedCount = 0;

      let insertedCount = 0;

      const batchResults = [];


      /* ---------------------------------------
         Supabase 저장
      --------------------------------------- */

      for (
        let batchIndex = 0;
        batchIndex < batches.length;
        batchIndex += 1
      ) {

        const batch =
          batches[
            batchIndex
          ];


        const {
          data,
          error,
        } = await supabase

          .from(
            "weflab_donations"
          )

          .upsert(
            batch,
            {
              onConflict:
                "dedupe_key",

              ignoreDuplicates:
                true,
            }
          )

          .select(
            "id,event_time,nickname,text,amount,round,created_at"
          );


        if (error) {

          console.error(
            `❌ Weflab 배치 ${
              batchIndex + 1
            } 저장 실패:`,
            error
          );


          return res
            .status(500)
            .json({
              success: false,

              message:
                "Weflab 데이터 저장 중 오류가 발생했습니다.",

              batch:
                batchIndex + 1,

              processedBeforeError:
                processedCount,

              error:
                error.message,

              details:
                error.details ||
                null,

              hint:
                error.hint ||
                null,

              code:
                error.code ||
                null,
            });

        }


        processedCount +=
          batch.length;


        const returnedCount =
          Array.isArray(data)
            ? data.length
            : 0;


        insertedCount +=
          returnedCount;


        batchResults.push({
          batch:
            batchIndex + 1,

          requested:
            batch.length,

          returned:
            returnedCount,
        });

      }


      console.log(
        "✅ Weflab 저장 완료",
        {
          received:
            rows.length,

          valid:
            parsedRows.length,

          unique:
            uniqueRows.length,

          processed:
            processedCount,

          inserted:
            insertedCount,

          skipped:
            skippedRows.length,
        }
      );


      return res
        .status(201)
        .json({
          success: true,

          message:
            "Weflab 데이터를 저장했습니다.",

          received:
            rows.length,

          valid:
            parsedRows.length,

          unique:
            uniqueRows.length,

          processed:
            processedCount,

          inserted:
            insertedCount,

          batches:
            batches.length,

          skipped:
            skippedRows.length,

          skippedRows,

          batchResults,
        });

    } catch (error) {

      console.error(
        "❌ Weflab 저장 오류:",
        error
      );


      return res
        .status(500)
        .json({
          success: false,

          message:
            "Weflab 데이터 처리 중 오류가 발생했습니다.",

          error:
            error.message,
        });

    }

  }
);


/* =========================================================
   Weflab 회차 목록 조회
========================================================= */

/*
 * GET /weflab-rounds
 *
 * 응답:
 *
 * {
 *   success: true,
 *   count: 2,
 *   data: [
 *     "ARTS1회차",
 *     "ARTS2회차"
 *   ]
 * }
 */

app.get(
  "/weflab-rounds",
  async (req, res) => {

    try {

      /*
       * Supabase/PostgREST는 기본적으로
       * 한 요청에 최대 1000행 제한이 있을 수 있으므로
       * 1000건씩 전체 round를 가져옵니다.
       */

      const batchSize =
        1000;


      let from = 0;

      let allRounds = [];


      while (true) {

        const to =
          from +
          batchSize -
          1;


        const {
          data,
          error,
        } = await supabase

          .from(
            "weflab_donations"
          )

          .select(
            "round"
          )

          .not(
            "round",
            "is",
            null
          )

          .range(
            from,
            to
          );


        if (error) {
          throw error;
        }


        const rows =
          data || [];


        allRounds =
          allRounds.concat(
            rows
          );


        if (
          rows.length <
          batchSize
        ) {
          break;
        }


        from +=
          batchSize;


        /*
         * 비정상적인 무한 조회 방지
         */

        if (
          allRounds.length >=
          100000
        ) {
          break;
        }

      }


      /* ---------------------------------------
         중복 제거
      --------------------------------------- */

      const rounds =
        [
          ...new Set(
            allRounds

              .map(
                (item) =>
                  String(
                    item.round || ""
                  ).trim()
              )

              .filter(Boolean)
          ),
        ];


      /* ---------------------------------------
         자연스러운 회차 정렬
      --------------------------------------- */

      rounds.sort(
        (a, b) =>
          a.localeCompare(
            b,
            "ko-KR",
            {
              numeric: true,
            }
          )
      );


      return res
        .status(200)
        .json({
          success: true,

          count:
            rounds.length,

          data:
            rounds,
        });

    } catch (error) {

      console.error(
        "❌ Weflab 회차 목록 조회 오류:",
        error
      );


      return res
        .status(500)
        .json({
          success: false,

          message:
            "Weflab 회차 목록 조회에 실패했습니다.",

          error:
            error.message,
        });

    }

  }
);


/* =========================================================
   Weflab 데이터 페이지 조회
========================================================= */

/*
 * GET /weflab-data
 *
 * 전체:
 *
 * /weflab-data?page=1&limit=500
 *
 *
 * 회차:
 *
 * /weflab-data?page=1&limit=500&round=ARTS1회차
 */

app.get(
  "/weflab-data",
  async (req, res) => {

    try {

      const requestedPage =
        Number(
          req.query.page
        ) || 1;


      const requestedLimit =
        Number(
          req.query.limit
        ) ||
        WEFLAB_DEFAULT_PAGE_SIZE;


      const page =
        Math.max(
          Number.isSafeInteger(
            requestedPage
          )
            ? requestedPage
            : 1,
          1
        );


      /*
       * 한 페이지 최대 1000개
       */

      const limit =
        Math.min(
          Math.max(
            Number.isSafeInteger(
              requestedLimit
            )
              ? requestedLimit
              : WEFLAB_DEFAULT_PAGE_SIZE,
            1
          ),

          WEFLAB_MAX_PAGE_SIZE
        );


      const from =
        (page - 1) *
        limit;


      const to =
        from +
        limit -
        1;


      /* ---------------------------------------
         회차 필터
      --------------------------------------- */

      const round =
        String(
          req.query.round ||
          ""
        ).trim();


      /* ---------------------------------------
         기본 Query
      --------------------------------------- */

      let query =
        supabase

          .from(
            "weflab_donations"
          )

          .select(
            "id,event_time,nickname,text,amount,round,created_at",
            {
              count:
                "exact",
            }
          );


      /* ---------------------------------------
         회차 선택
      --------------------------------------- */

      if (round) {

        query =
          query.eq(
            "round",
            round
          );

      }


      /* ---------------------------------------
         정렬 + 페이지 범위
      --------------------------------------- */

      query =
        query

          .order(
            "event_time",
            {
              ascending:
                true,
            }
          )

          .order(
            "id",
            {
              ascending:
                true,
            }
          )

          .range(
            from,
            to
          );


      const {
        data,
        error,
        count,
      } = await query;


      if (error) {
        throw error;
      }


      const total =
        typeof count ===
        "number"
          ? count
          : 0;


      const totalPages =
        total === 0
          ? 0
          : Math.ceil(
              total /
              limit
            );


      return res
        .status(200)
        .json({
          success: true,

          round:
            round || null,

          page,

          limit,

          count:
            data?.length ||
            0,

          total,

          totalPages,

          hasNextPage:
            page <
            totalPages,

          hasPreviousPage:
            page > 1,

          data:
            data || [],
        });

    } catch (error) {

      console.error(
        "❌ Weflab 조회 오류:",
        error
      );


      return res
        .status(500)
        .json({
          success: false,

          message:
            "Weflab 데이터 조회에 실패했습니다.",

          error:
            error.message,
        });

    }

  }
);


/* =========================================================
   Weflab 전체 데이터 조회
========================================================= */

/*
 * GET /weflab-data/all
 *
 * 전체 회차:
 *
 * /weflab-data/all
 *
 *
 * 특정 회차:
 *
 * /weflab-data/all?round=ARTS1회차
 *
 *
 * DB에서 1000개씩 반복 조회합니다.
 */

app.get(
  "/weflab-data/all",
  async (req, res) => {

    try {

      const batchSize =
        1000;


      let from = 0;

      let allData = [];


      /* ---------------------------------------
         회차 필터
      --------------------------------------- */

      const round =
        String(
          req.query.round ||
          ""
        ).trim();


      while (true) {

        const to =
          from +
          batchSize -
          1;


        /* ---------------------------------------
           Query 생성
        --------------------------------------- */

        let query =
          supabase

            .from(
              "weflab_donations"
            )

            .select(
              "id,event_time,nickname,text,amount,round,created_at"
            );


        /* ---------------------------------------
           특정 회차
        --------------------------------------- */

        if (round) {

          query =
            query.eq(
              "round",
              round
            );

        }


        /* ---------------------------------------
           정렬 + 범위
        --------------------------------------- */

        query =
          query

            .order(
              "event_time",
              {
                ascending:
                  true,
              }
            )

            .order(
              "id",
              {
                ascending:
                  true,
              }
            )

            .range(
              from,
              to
            );


        const {
          data,
          error,
        } = await query;


        if (error) {
          throw error;
        }


        const rows =
          data || [];


        allData =
          allData.concat(
            rows
          );


        /*
         * 1000개보다 적게 왔다 =
         * 마지막 페이지
         */

        if (
          rows.length <
          batchSize
        ) {
          break;
        }


        from +=
          batchSize;


        /*
         * 메모리 보호
         */

        if (
          allData.length >=
          100000
        ) {

          return res
            .status(413)
            .json({
              success: false,

              message:
                "데이터가 100,000개 이상입니다. 페이지 조회를 사용해주세요.",

              round:
                round || null,

              loaded:
                allData.length,
            });

        }

      }


      return res
        .status(200)
        .json({
          success: true,

          round:
            round || null,

          count:
            allData.length,

          data:
            allData,
        });

    } catch (error) {

      console.error(
        "❌ Weflab 전체 조회 오류:",
        error
      );


      return res
        .status(500)
        .json({
          success: false,

          message:
            "Weflab 전체 데이터 조회에 실패했습니다.",

          error:
            error.message,
        });

    }

  }
);


/* =========================================================
   Weflab 특정 데이터 조회
========================================================= */

/*
 * GET /weflab-data/123
 */

app.get(
  "/weflab-data/:id",
  async (req, res) => {

    try {

      const id =
        Number(
          req.params.id
        );


      if (
        !Number.isSafeInteger(
          id
        ) ||
        id <= 0
      ) {

        return res
          .status(400)
          .json({
            success: false,

            message:
              "올바른 ID가 아닙니다.",
          });

      }


      const {
        data,
        error,
      } = await supabase

        .from(
          "weflab_donations"
        )

        .select(
          "id,event_time,nickname,text,amount,round,created_at"
        )

        .eq(
          "id",
          id
        )

        .maybeSingle();


      if (error) {
        throw error;
      }


      if (!data) {

        return res
          .status(404)
          .json({
            success: false,

            message:
              "해당 Weflab 데이터를 찾을 수 없습니다.",
          });

      }


      return res
        .status(200)
        .json({
          success: true,

          data,
        });

    } catch (error) {

      console.error(
        "❌ Weflab 상세 조회 오류:",
        error
      );


      return res
        .status(500)
        .json({
          success: false,

          message:
            "Weflab 상세 조회에 실패했습니다.",

          error:
            error.message,
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
