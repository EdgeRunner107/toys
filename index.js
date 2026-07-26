require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const WebSocket = require("ws");

const app = express();

const PORT = Number(process.env.PORT) || 8888;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

if (!SUPABASE_URL) {
  console.error("❌ SUPABASE_URL 환경변수가 없습니다.");
  process.exit(1);
}

if (!SUPABASE_SECRET_KEY) {
  console.error("❌ SUPABASE_SECRET_KEY 환경변수가 없습니다.");
  process.exit(1);
}

if (!WEBHOOK_SECRET) {
  console.error("❌ WEBHOOK_SECRET 환경변수가 없습니다.");
  process.exit(1);
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SECRET_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },

    realtime: {
      transport: WebSocket,
    },
  }
);

app.set("trust proxy", 1);

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(
  express.urlencoded({
    extended: true,
    limit: "10mb",
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "10mb",
  })
);

/**
 * 서버 상태 확인
 *
 * GET http://localhost:8888/
 */
app.get("/", (req, res) => {
  return res.status(200).json({
    success: true,
    message: "Webhook 서버가 정상적으로 실행 중입니다.",
    serverTime: new Date().toISOString(),
  });
});

/**
 * 헬스 체크
 *
 * GET http://localhost:8888/health
 */
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
    console.error("❌ 헬스 체크 실패:", error);

    return res.status(500).json({
      success: false,
      server: "online",
      database: "disconnected",
      error: error.message,
    });
  }
});

/**
 * 웹훅 수신 API
 *
 * POST http://localhost:8888/webhook
 *
 * 헤더:
 * x-webhook-secret: .env에 설정한 WEBHOOK_SECRET
 */
app.post("/webhook", async (req, res) => {
  try {
    const receivedSecret = req.get("x-webhook-secret");

    /**
     * 웹훅 비밀키 확인
     */
    if (!receivedSecret || receivedSecret !== WEBHOOK_SECRET) {
      console.warn("⚠️ 인증되지 않은 웹훅 요청:", req.ip);

      return res.status(401).json({
        success: false,
        message: "웹훅 인증에 실패했습니다.",
      });
    }

    const payload = req.body;

    /**
     * 요청 본문 확인
     */
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      Object.keys(payload).length === 0
    ) {
      return res.status(400).json({
        success: false,
        message: "저장할 JSON 데이터가 없습니다.",
      });
    }

    /**
     * payload 안에 type 또는 event가 있으면 event_type으로 저장
     */
    const eventType =
      payload.type ||
      payload.event ||
      payload.event_type ||
      "unknown";

    /**
     * 필요한 헤더만 저장
     *
     * 전체 헤더를 저장하면 인증정보가 포함될 수 있으므로
     * 필요한 값만 선택해서 저장합니다.
     */
    const requestHeaders = {
      "content-type": req.get("content-type") || null,
      "user-agent": req.get("user-agent") || null,
      "x-forwarded-for": req.get("x-forwarded-for") || null,
    };

    const senderIp =
      req.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.ip ||
      null;

    /**
     * Supabase 저장
     */
    const { data, error } = await supabase
      .from("webhook_logs")
      .insert([
        {
          event_type: String(eventType),
          payload,
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
      });
    }

    console.log("✅ 웹훅 저장 완료:", {
      id: data.id,
      eventType: data.event_type,
      createdAt: data.created_at,
    });

    return res.status(201).json({
      success: true,
      message: "웹훅 데이터를 저장했습니다.",
      data: {
        id: data.id,
        eventType: data.event_type,
        createdAt: data.created_at,
      },
    });
  } catch (error) {
    console.error("❌ 웹훅 처리 중 예상하지 못한 오류:", error);

    return res.status(500).json({
      success: false,
      message: "서버 내부 오류가 발생했습니다.",
      error: error.message,
    });
  }
});

/**
 * 최근 웹훅 목록 확인
 *
 * GET http://localhost:8888/webhook-logs
 */
app.get("/webhook-logs", async (req, res) => {
  try {
    const requestedLimit = Number(req.query.limit) || 50;
    const limit = Math.min(Math.max(requestedLimit, 1), 500);

    const { data, error } = await supabase
      .from("webhook_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

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

/**
 * 처리 완료 상태 변경
 *
 * PATCH http://localhost:8888/webhook-logs/1/processed
 *
 * body:
 * {
 *   "processed": true
 * }
 */
app.patch("/webhook-logs/:id/processed", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { processed } = req.body;

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "올바른 ID가 아닙니다.",
      });
    }

    if (typeof processed !== "boolean") {
      return res.status(400).json({
        success: false,
        message: "processed 값은 true 또는 false여야 합니다.",
      });
    }

    const { data, error } = await supabase
      .from("webhook_logs")
      .update({
        processed,
      })
      .eq("id", id)
      .select()
      .single();

    if (error) {
      throw error;
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
});

/**
 * 존재하지 않는 API
 */
app.use((req, res) => {
  return res.status(404).json({
    success: false,
    message: "존재하지 않는 API 주소입니다.",
    method: req.method,
    path: req.originalUrl,
  });
});

/**
 * 서버 실행
 */
app.listen(PORT, "0.0.0.0", () => {
  console.log("-----------------------------------------");
  console.log(`✅ 서버 실행 완료`);
  console.log(`✅ 로컬 주소: http://localhost:${PORT}`);
  console.log(`✅ 웹훅 주소: http://localhost:${PORT}/webhook`);
  console.log(`✅ 상태 확인: http://localhost:${PORT}/health`);
  console.log("-----------------------------------------");
});