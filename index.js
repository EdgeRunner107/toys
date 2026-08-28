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
   Weflab 설정
========================================================= */

const WEFLAB_INSERT_BATCH_SIZE = 500;
const WEFLAB_DEFAULT_PAGE_SIZE = 500;
const WEFLAB_MAX_PAGE_SIZE = 1000;


/* =========================================================
   Weflab 공통 함수
========================================================= */


/* ---------------------------------------------------------
   문자열 정리
--------------------------------------------------------- */

function cleanWeflabString(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return "";
  }

  return String(value).trim();
}


/* ---------------------------------------------------------
   시간 변환

   지원:
   2026-03-27 16:26:30
   2026-03-27T16:26:30
   Excel Date 객체
--------------------------------------------------------- */

function normalizeWeflabEventTime(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }


  /*
   * Date 객체
   */

  if (
    value instanceof Date &&
    !Number.isNaN(value.getTime())
  ) {

    const year =
      value.getFullYear();

    const month =
      String(
        value.getMonth() + 1
      ).padStart(2, "0");

    const day =
      String(
        value.getDate()
      ).padStart(2, "0");

    const hour =
      String(
        value.getHours()
      ).padStart(2, "0");

    const minute =
      String(
        value.getMinutes()
      ).padStart(2, "0");

    const second =
      String(
        value.getSeconds()
      ).padStart(2, "0");


    return (
      `${year}-${month}-${day} ` +
      `${hour}:${minute}:${second}`
    );
  }


  let text =
    String(value)
      .replace(/\u00a0/g, " ")
      .trim();


  /*
   * T 형식도 DB timestamp 형식으로
   */

  text =
    text.replace(
      /^(\d{4}-\d{2}-\d{2})T/,
      "$1 "
    );


  /*
   * 공백 여러 개 제거
   */

  text =
    text.replace(
      /\s+/g,
      " "
    );


  /*
   * YYYY-MM-DD HH:mm:ss
   */

  const match =
    text.match(
      /^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})/
    );


  if (match) {

    const hour =
      String(match[2])
        .padStart(2, "0");


    return (
      `${match[1]} ` +
      `${hour}:${match[3]}:${match[4]}`
    );

  }


  return null;
}


/* ---------------------------------------------------------
   닉네임 정리

   입력:
   근이는하리★<br>(ldgcd)

   결과:
   근이는하리★
--------------------------------------------------------- */

function parseWeflabNickname(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return "";
  }


  let text =
    String(value);


  /*
   * HTML <br>
   */

  text =
    text.replace(
      /<br\s*\/?>/gi,
      "\n"
    );


  /*
   * 첫 줄만 닉네임으로 사용
   */

  let nickname =
    text
      .split(/\r?\n/)
      [0]
      .trim();


  /*
   * 혹시 한 줄 형태
   * 닉네임 (userid)
   */

  nickname =
    nickname.replace(
      /\s*\([^()]+\)\s*$/,
      ""
    );


  return nickname.trim();
}


/* ---------------------------------------------------------
   숫자 파싱

   1,015개 -> 1015
   100개   -> 100
   1015    -> 1015
   ""      -> null

   "1개월"은 amount가 아니라 구독기간이므로
   여기서는 null
--------------------------------------------------------- */

function parseWeflabAmount(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }


  const text =
    String(value).trim();


  if (!text) {
    return null;
  }


  /*
   * 구독 데이터
   */

  if (
    text.includes("개월") ||
    text.includes("구독")
  ) {
    return null;
  }


  const cleaned =
    text.replace(
      /[^0-9-]/g,
      ""
    );


  if (!cleaned) {
    return null;
  }


  const number =
    Number(cleaned);


  if (
    !Number.isFinite(number)
  ) {
    return null;
  }


  return number;
}


/* ---------------------------------------------------------
   회차 추출

   지원:
   round
   회차
   회차명

   그리고 마지막 컬럼에서 "회차" 문자열 탐색
--------------------------------------------------------- */

function extractWeflabRound(row) {
  if (
    !row ||
    typeof row !== "object"
  ) {
    return "";
  }


  const candidates = [
    row.round,
    row["회차"],
    row["회차명"],
    row.round_name,
    row.roundName,
  ];


  for (
    const value of candidates
  ) {

    if (
      value !== null &&
      value !== undefined &&
      String(value).trim()
    ) {

      return String(value)
        .replace(/<br\s*\/?>/gi, "")
        .trim();

    }

  }


  /*
   * 헤더가 정확하지 않은 경우
   * 마지막 컬럼 쪽에서 회차 탐색
   */

  const values =
    Object.values(row);


  for (
    let i = values.length - 1;
    i >= 0;
    i -= 1
  ) {

    if (
      values[i] === null ||
      values[i] === undefined
    ) {
      continue;
    }


    const value =
      String(values[i])
        .replace(
          /<br\s*\/?>/gi,
          ""
        )
        .trim();


    if (
      value.includes("회차")
    ) {
      return value;
    }

  }


  return "";
}


/* ---------------------------------------------------------
   donation_value 추출

   원본:
   후원,구독 = 1,015개
   후원,구독 = 1개월
--------------------------------------------------------- */

function extractWeflabDonationValue(row) {
  const candidates = [
    row.donation_value,
    row["후원,구독"],
    row["후원/구독"],
    row["후원"],
    row.donation,
  ];


  for (
    const value of candidates
  ) {

    if (
      value !== null &&
      value !== undefined &&
      String(value).trim()
    ) {

      return String(value)
        .trim();

    }

  }


  return "";
}


/* ---------------------------------------------------------
   멤버 추출
--------------------------------------------------------- */

function extractWeflabMember(row) {
  const value =
    row.member ??
    row["멤버"] ??
    row["스트리머"] ??
    "";


  return cleanWeflabString(
    value
  );
}


/* ---------------------------------------------------------
   amount 추출

   마지막숫자 우선
   없으면 donation_value에서 추출

   1개월 같은 구독은 null
--------------------------------------------------------- */

function extractWeflabAmount(
  row,
  donationValue
) {

  const candidates = [
    row.amount,
    row["마지막숫자"],
    row["마지막 숫자"],
    row["점수"],
    row.score,
  ];


  for (
    const value of candidates
  ) {

    if (
      value === null ||
      value === undefined ||
      value === ""
    ) {
      continue;
    }


    const amount =
      parseWeflabAmount(
        value
      );


    if (
      amount !== null
    ) {
      return amount;
    }

  }


  return parseWeflabAmount(
    donationValue
  );
}


/* ---------------------------------------------------------
   중복키 생성

   회차까지 포함

   회차
   시간
   닉네임
   후원/구독
   채팅
   멤버
   금액
--------------------------------------------------------- */

function createWeflabDedupeKey({
  eventTime,
  nickname,
  donationValue,
  text,
  member,
  amount,
  round,
}) {

  return [
    round || "",
    eventTime || "",
    nickname || "",
    donationValue || "",
    text || "",
    member || "",
    amount ?? "",
  ].join("|");
}


/* ---------------------------------------------------------
   Weflab 한 행 파싱
--------------------------------------------------------- */

function parseWeflabRow(row) {
  try {

    if (
      !row ||
      typeof row !== "object"
    ) {

      return {
        valid: false,
        reason:
          "올바른 객체 데이터가 아닙니다.",
      };

    }


    /* ==========================================
       시간
    ========================================== */

    const rawEventTime =
      row.event_time ??
      row["시간"] ??
      row.time ??
      row.datetime;


    const eventTime =
      normalizeWeflabEventTime(
        rawEventTime
      );


    if (!eventTime) {

      return {
        valid: false,
        reason:
          "시간이 없거나 형식이 올바르지 않습니다.",
      };

    }


    /* ==========================================
       닉네임
    ========================================== */

    const nickname =
      parseWeflabNickname(
        row.nickname ??
        row["이름"] ??
        row.name
      );


    if (!nickname) {

      return {
        valid: false,
        reason:
          "닉네임이 없습니다.",
      };

    }


    /* ==========================================
       후원 / 구독 원본값
    ========================================== */

    const donationValue =
      extractWeflabDonationValue(
        row
      );


    /* ==========================================
       채팅
    ========================================== */

    const text =
      cleanWeflabString(
        row.text ??
        row["채팅"] ??
        row.message
      );


    /* ==========================================
       멤버
    ========================================== */

    const member =
      extractWeflabMember(
        row
      );


    /* ==========================================
       amount
    ========================================== */

    const amount =
      extractWeflabAmount(
        row,
        donationValue
      );


    /*
     * amount는 null이어도 정상입니다.
     *
     * 예:
     * donation_value = "1개월"
     * amount = null
     */


    /* ==========================================
       회차
    ========================================== */

    const round =
      extractWeflabRound(
        row
      );


    if (!round) {

      return {
        valid: false,
        reason:
          "회차 정보가 없습니다.",
      };

    }


    /* ==========================================
       중복키
    ========================================== */

    const dedupeKey =
      createWeflabDedupeKey({
        eventTime,
        nickname,
        donationValue,
        text,
        member,
        amount,
        round,
      });


    return {
      valid: true,

      data: {
        event_time:
          eventTime,

        nickname,

        donation_value:
          donationValue ||
          null,

        text:
          text ||
          null,

        member:
          member ||
          null,

        amount,

        round,

        dedupe_key:
          dedupeKey,
      },
    };

  } catch (error) {

    return {
      valid: false,

      reason:
        error?.message ||
        "데이터 파싱 중 오류가 발생했습니다.",
    };

  }
}


/* ---------------------------------------------------------
   배열 분할
--------------------------------------------------------- */

function chunkWeflabArray(
  array,
  size
) {

  const chunks = [];


  for (
    let i = 0;
    i < array.length;
    i += size
  ) {

    chunks.push(
      array.slice(
        i,
        i + size
      )
    );

  }


  return chunks;
}


/* =========================================================
   Weflab 데이터 저장
========================================================= */

/*
 * POST /weflab-data
 *
 * 배열:
 *
 * [
 *   {...},
 *   {...}
 * ]
 *
 * 또는:
 *
 * {
 *   "data": [...]
 * }
 */

app.post(
  "/weflab-data",
  async (req, res) => {

    try {

      const body =
        req.body;


      let rows = [];


      /* ==========================================
         요청 형식 확인
      ========================================== */

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


      /* ==========================================
         데이터 파싱
      ========================================== */

      const parsedRows = [];

      const skippedRows = [];


      for (
        let index = 0;
        index < rows.length;
        index += 1
      ) {

        const result =
          parseWeflabRow(
            rows[index]
          );


        if (
          !result.valid
        ) {

          skippedRows.push({
            index,

            reason:
              result.reason,

            row:
              rows[index],
          });


          continue;

        }


        parsedRows.push(
          result.data
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


      /* ==========================================
         요청 내부 중복 제거
      ========================================== */

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


      /* ==========================================
         배치 분할
      ========================================== */

      const batches =
        chunkWeflabArray(
          uniqueRows,
          WEFLAB_INSERT_BATCH_SIZE
        );


      let processedCount = 0;

      let insertedCount = 0;

      const batchResults = [];


      /* ==========================================
         Supabase 저장
      ========================================== */

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
            [
              "id",
              "event_time",
              "nickname",
              "donation_value",
              "text",
              "member",
              "amount",
              "round",
              "created_at",
            ].join(",")
          );


        if (error) {

          console.error(
            "❌ Weflab 저장 실패:",
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

          inserted:
            returnedCount,
        });

      }


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

          skipped:
            skippedRows.length,

          skippedRows,

          batches:
            batches.length,

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
   Weflab 회차 목록
========================================================= */

/*
 * GET /weflab-rounds
 */

app.get(
  "/weflab-rounds",
  async (req, res) => {

    try {

      const batchSize =
        1000;


      let from = 0;

      const allRows = [];


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


        if (error) {
          throw error;
        }


        const rows =
          data || [];


        allRows.push(
          ...rows
        );


        if (
          rows.length <
          batchSize
        ) {
          break;
        }


        from +=
          batchSize;


        if (
          from >=
          100000
        ) {
          break;
        }

      }


      const rounds =
        [
          ...new Set(
            allRows

              .map(
                (row) =>
                  cleanWeflabString(
                    row.round
                  )
              )

              .filter(Boolean)
          ),
        ];


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
        "❌ Weflab 회차 조회 오류:",
        error
      );


      return res
        .status(500)
        .json({
          success: false,

          message:
            "회차 목록 조회에 실패했습니다.",

          error:
            error.message,
        });

    }

  }
);


/* =========================================================
   Weflab 페이지 조회
========================================================= */

/*
 * GET /weflab-data
 *
 * 전체:
 * /weflab-data?page=1&limit=500
 *
 * 특정 회차:
 * /weflab-data?page=1&limit=500&round=ARTS1회차
 */

app.get(
  "/weflab-data",
  async (req, res) => {

    try {

      const requestedPage =
        Number(
          req.query.page
        );


      const requestedLimit =
        Number(
          req.query.limit
        );


      const page =
        Number.isSafeInteger(
          requestedPage
        ) &&
        requestedPage > 0
          ? requestedPage
          : 1;


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


      const round =
        cleanWeflabString(
          req.query.round
        );


      let query =
        supabase

          .from(
            "weflab_donations"
          )

          .select(
            [
              "id",
              "event_time",
              "nickname",
              "donation_value",
              "text",
              "member",
              "amount",
              "round",
              "created_at",
            ].join(","),
            {
              count:
                "exact",
            }
          );


      if (round) {

        query =
          query.eq(
            "round",
            round
          );

      }


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
            round ||
            null,

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
   Weflab 전체 조회
========================================================= */

/*
 * GET /weflab-data/all
 *
 * 전체:
 * /weflab-data/all
 *
 * 회차:
 * /weflab-data/all?round=ARTS1회차
 */

app.get(
  "/weflab-data/all",
  async (req, res) => {

    try {

      const batchSize =
        1000;


      const round =
        cleanWeflabString(
          req.query.round
        );


      let from = 0;

      let allData = [];


      while (true) {

        const to =
          from +
          batchSize -
          1;


        let query =
          supabase

            .from(
              "weflab_donations"
            )

            .select(
              [
                "id",
                "event_time",
                "nickname",
                "donation_value",
                "text",
                "member",
                "amount",
                "round",
                "created_at",
              ].join(",")
            );


        if (round) {

          query =
            query.eq(
              "round",
              round
            );

        }


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


        if (
          rows.length <
          batchSize
        ) {
          break;
        }


        from +=
          batchSize;


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
                round ||
                null,

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
            round ||
            null,

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
 * GET /weflab-data/1
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
          [
            "id",
            "event_time",
            "nickname",
            "donation_value",
            "text",
            "member",
            "amount",
            "round",
            "created_at",
          ].join(",")
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
