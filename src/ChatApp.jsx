import React, { useState, useRef, useEffect, useCallback } from "react";

// ---------- Supabase 설정 ----------
const SUPABASE_URL = "https://afcybstphdspdrgkvkzv.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFmY3lic3RwaGRzcGRyZ2t2a3p2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ2ODkwMjAsImV4cCI6MjEwMDI2NTAyMH0.6WNnaXFopFhC_N2IgnQbY8MrCSITRop0am4MBg28qAc";

const SB_HEADERS = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  "Content-Type": "application/json",
};

const CONFIGURED = !SUPABASE_URL.includes("YOUR-PROJECT-ID");

async function sbSelect(table, query = "") {
  const url = `${SUPABASE_URL}/rest/v1/${table}?apikey=${SUPABASE_ANON_KEY}&${query}`;
  const res = await fetch(url, {
    headers: SB_HEADERS,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`${table} 조회 실패: ${res.status} ${errText}`);
  }
  return res.json();
}

async function sbInsert(table, body) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?apikey=${SUPABASE_ANON_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...SB_HEADERS, Prefer: "return=representation" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`${table} 저장 실패: ${res.status} ${err}`);
  }
  return res.json();
}

function subscribeToMessages(onInsert) {
  const wsUrl =
    SUPABASE_URL.replace("https://", "wss://") +
    `/realtime/v1/websocket?apikey=${SUPABASE_ANON_KEY}&vsn=1.0.0`;
  const ws = new WebSocket(wsUrl);
  let ref = 1;

  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        topic: "realtime:public:messages",
        event: "phx_join",
        payload: {},
        ref: ref++,
      })
    );
    const heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ topic: "phoenix", event: "heartbeat", payload: {}, ref: ref++ }));
      }
    }, 25000);
    ws._heartbeat = heartbeat;
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.event === "INSERT" && msg.payload?.record) {
        onInsert(msg.payload.record);
      }
    } catch (e) {
      // ignore
    }
  };

  return () => {
    clearInterval(ws._heartbeat);
    ws.close();
  };
}

// ---------- 데이터 ----------

const initialServers = [
  { id: "s1", name: "우리 서버", icon: "우" },
];

function randomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 10; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out.slice(0, 4) + "-" + out.slice(4, 8);
}

function initials(name) {
  return name?.trim()?.[0]?.toUpperCase() || "?";
}

function avatarColor(seed) {
  const colors = ["#5865F2", "#EB459E", "#57F287", "#FEE75C", "#ED4245", "#9B59B6", "#3BA55D"];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % colors.length;
  return colors[h];
}

// ---------- 가짜 404 화면 ----------
function FakeNotFound({ onUnlock }) {
  const [buf, setBuf] = useState("");

  useEffect(() => {
    function handler(e) {
      if (e.key >= "0" && e.key <= "9") {
        setBuf((prev) => {
          const next = (prev + e.key).slice(-2);
          if (next === "67") {
            setTimeout(() => onUnlock(), 120);
            return "";
          }
          return next;
        });
      } else {
        setBuf("");
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onUnlock]);

  return (
    <div
      style={{
        minHeight: "100vh",
        width: "100%",
        background: "#ffffff",
        color: "#1a1a1a",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif",
        userSelect: "none",
      }}
    >
      <div style={{ fontSize: 15, letterSpacing: 1, color: "#8a8a8a", marginBottom: 8 }}>
        404
      </div>
      <div style={{ fontSize: 22, fontWeight: 500, color: "#333" }}>
        This page isn't working
      </div>
      <div style={{ fontSize: 14, color: "#9a9a9a", marginTop: 10 }}>
        The requested URL was not found on this server.
      </div>
    </div>
  );
}

// ---------- 라이선스 입력 팝업 ----------
function LicenseModal({ onSubmit, error, errorMsg, checking, onClose }) {
  const [value, setValue] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif",
      }}
    >
      <div
        style={{
          background: "#313338",
          borderRadius: 8,
          width: 420,
          maxWidth: "90vw",
          padding: "32px 28px",
          boxShadow: "0 8px 40px rgba(0,0,0,0.5)",
        }}
      >
        <div style={{ textAlign: "center", marginBottom: 4 }}>
          <div style={{ color: "#fff", fontSize: 20, fontWeight: 700 }}>라이선스 코드 입력</div>
          <div style={{ color: "#b5bac1", fontSize: 14, marginTop: 6 }}>
            관리자에게 받은 코드를 입력하세요
          </div>
        </div>
        <div style={{ marginTop: 20 }}>
          <label style={{ color: "#b5bac1", fontSize: 12, fontWeight: 700, textTransform: "uppercase" }}>
            License Code
          </label>
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !checking) onSubmit(value.trim());
            }}
            placeholder="XXXX-XXXX"
            disabled={checking}
            style={{
              width: "100%",
              marginTop: 6,
              padding: "10px 12px",
              borderRadius: 4,
              border: "none",
              outline: error ? "2px solid #ed4245" : "none",
              background: "#1e1f22",
              color: "#fff",
              fontSize: 15,
              boxSizing: "border-box",
              opacity: checking ? 0.6 : 1,
            }}
          />
          {error && (
            <div style={{ color: "#ed4245", fontSize: 13, marginTop: 6 }}>
              {errorMsg || "코드가 올바르지 않습니다. 접속이 종료됩니다."}
            </div>
          )}
        </div>
        <button
          onClick={() => !checking && onSubmit(value.trim())}
          disabled={checking}
          style={{
            width: "100%",
            marginTop: 20,
            padding: "11px 0",
            borderRadius: 4,
            border: "none",
            background: checking ? "#454a52" : "#5865F2",
            color: "#fff",
            fontWeight: 600,
            fontSize: 15,
            cursor: checking ? "default" : "pointer",
          }}
        >
          {checking ? "확인 중..." : "입장하기"}
        </button>
        <div
          onClick={onClose}
          style={{
            textAlign: "center",
            marginTop: 14,
            color: "#7f8489",
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          취소
        </div>
      </div>
    </div>
  );
}

// ---------- 접속 차단(코드 오류) 화면 ----------
function KilledScreen() {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#000",
        color: "#666",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "monospace",
        fontSize: 14,
      }}
    >
      connection closed
    </div>
  );
}

// ---------- 관리자: 화이트리스트 패널 ----------
function AdminPanel({ onClose }) {
  const [name, setName] = useState("");
  const [whitelist, setWhitelist] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    let cancelled = false;
    sbSelect("whitelist", "select=id,name,code&order=id.desc")
      .then((rows) => {
        if (!cancelled) setWhitelist(rows);
      })
      .catch(() => setErr("목록을 불러오지 못했습니다."))
      .finally(() => setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  async function addUser() {
    if (!name.trim() || adding) return;
    setAdding(true);
    setErr("");
    const code = randomCode();
    try {
      const [saved] = await sbInsert("whitelist", { name: name.trim(), code });
      setWhitelist((prev) => [saved, ...prev]);
      setName("");
    } catch (e) {
      setErr("추가 실패. 코드가 중복되었을 수 있어요, 다시 시도해주세요.");
    } finally {
      setAdding(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 60,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif",
      }}
    >
      <div
        style={{
          background: "#313338",
          borderRadius: 8,
          width: 460,
          maxWidth: "92vw",
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 8px 40px rgba(0,0,0,0.5)",
        }}
      >
        <div style={{ padding: "20px 22px 12px", borderBottom: "1px solid #26272b" }}>
          <div style={{ color: "#fff", fontSize: 18, fontWeight: 700 }}>화이트리스트 관리</div>
          <div style={{ color: "#949ba4", fontSize: 13, marginTop: 4 }}>
            사용자를 추가하면 랜덤 라이선스 코드가 발급됩니다.
          </div>
        </div>

        <div style={{ padding: "16px 22px", display: "flex", gap: 8 }}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addUser()}
            placeholder="사용자 이름"
            style={{
              flex: 1,
              padding: "9px 10px",
              borderRadius: 4,
              border: "none",
              background: "#1e1f22",
              color: "#fff",
              fontSize: 14,
              outline: "none",
            }}
          />
          <button
            onClick={addUser}
            disabled={adding}
            style={{
              padding: "9px 16px",
              borderRadius: 4,
              border: "none",
              background: adding ? "#1c5c33" : "#248046",
              color: "#fff",
              fontWeight: 600,
              fontSize: 14,
              cursor: adding ? "default" : "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {adding ? "추가 중..." : "+ 화이트리스트 추가"}
          </button>
        </div>

        {err && (
          <div style={{ color: "#ed4245", fontSize: 12, padding: "0 22px 8px" }}>{err}</div>
        )}

        <div style={{ overflowY: "auto", padding: "0 22px 16px", flex: 1 }}>
          {loading && (
            <div style={{ color: "#6d6f78", fontSize: 13, padding: "16px 0" }}>불러오는 중...</div>
          )}
          {!loading && whitelist.length === 0 && (
            <div style={{ color: "#6d6f78", fontSize: 13, padding: "16px 0" }}>
              아직 추가된 사용자가 없습니다.
            </div>
          )}
          {whitelist.map((u) => (
            <div
              key={u.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                background: "#2b2d31",
                borderRadius: 6,
                padding: "10px 12px",
                marginBottom: 8,
              }}
            >
              <div>
                <div style={{ color: "#fff", fontSize: 14, fontWeight: 600 }}>{u.name}</div>
                <div style={{ color: "#949ba4", fontSize: 12, marginTop: 2, fontFamily: "monospace" }}>
                  {u.code}
                </div>
              </div>
              <button
                onClick={() => navigator.clipboard?.writeText(u.code)}
                style={{
                  background: "#3f4147",
                  border: "none",
                  color: "#dbdee1",
                  fontSize: 12,
                  padding: "6px 10px",
                  borderRadius: 4,
                  cursor: "pointer",
                }}
              >
                복사
              </button>
            </div>
          ))}
        </div>

        <div style={{ padding: "14px 22px", borderTop: "1px solid #26272b" }}>
          <button
            onClick={onClose}
            style={{
              width: "100%",
              padding: "10px 0",
              borderRadius: 4,
              border: "none",
              background: "#4e5058",
              color: "#fff",
              fontWeight: 600,
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

// ---------- 메인 디스코드 스타일 채팅 ----------
function ChatMain({ currentUser, isAdmin }) {
  const [channels, setChannels] = useState([]);
  const [activeChannel, setActiveChannel] = useState(null);
  const [showAdmin, setShowAdmin] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [loadingChannels, setLoadingChannels] = useState(true);
  const [connError, setConnError] = useState("");

  const bottomRef = useRef(null);

  // 채널 목록 로드 (최초 1회)
  useEffect(() => {
    let cancelled = false;
    sbSelect("channels", "select=id,name&order=id.asc")
      .then((rows) => {
        if (cancelled) return;
        setChannels(rows);
        if (rows.length > 0) setActiveChannel(rows[0].id);
      })
      .catch(() => setConnError("채널을 불러오지 못했습니다."))
      .finally(() => setLoadingChannels(false));
    return () => {
      cancelled = true;
    };
  }, []);

  // 채널 바뀔 때마다 해당 채널 메시지 로드
  useEffect(() => {
    if (activeChannel == null) return;
    let cancelled = false;
    sbSelect(
      "messages",
      `channel_id=eq.${activeChannel}&select=id,author,text,created_at&order=created_at.asc`
    )
      .then((rows) => {
        if (!cancelled) setMessages(rows);
      })
      .catch(() => setConnError("메시지를 불러오지 못했습니다."));
    return () => {
      cancelled = true;
    };
  }, [activeChannel]);

  // 새 메시지 실시간 구독 (전체 messages 테이블, 현재 채널만 필터링해 반영)
  useEffect(() => {
    const unsubscribe = subscribeToMessages((record) => {
      setMessages((prev) => {
        if (record.channel_id !== activeChannel) return prev;
        if (prev.some((m) => m.id === record.id)) return prev; // 중복 방지(내가 보낸 것 이미 반영된 경우)
        return [...prev, record];
      });
    });
    return unsubscribe;
  }, [activeChannel]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function sendMessage() {
    const text = input.trim();
    if (!text || activeChannel == null) return;
    setInput("");
    // 낙관적 업데이트: 내 화면엔 바로 표시
    const tempId = `temp-${Date.now()}`;
    const optimistic = {
      id: tempId,
      author: currentUser,
      text,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);
    try {
      const [saved] = await sbInsert("messages", {
        channel_id: activeChannel,
        author: currentUser,
        text,
      });
      // 서버가 준 실제 row로 교체 (id 등 확정)
      setMessages((prev) => prev.map((m) => (m.id === tempId ? saved : m)));
    } catch (e) {
      setConnError("메시지 전송 실패. 다시 시도해주세요.");
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
    }
  }

  const channelName = channels.find((c) => c.id === activeChannel)?.name || "";

  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        width: "100%",
        background: "#313338",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif",
        overflow: "hidden",
      }}
    >
      {/* 서버 레일 */}
      <div
        style={{
          width: 72,
          background: "#1e1f22",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          paddingTop: 12,
          gap: 8,
          flexShrink: 0,
        }}
      >
        {initialServers.map((s) => (
          <div
            key={s.id}
            title={s.name}
            style={{
              width: 48,
              height: 48,
              borderRadius: 16,
              background: "#5865F2",
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 700,
              fontSize: 18,
              cursor: "pointer",
              transition: "border-radius 0.15s, background 0.15s",
            }}
          >
            {s.icon}
          </div>
        ))}
      </div>

      {/* 채널 목록 */}
      <div
        style={{
          width: 240,
          background: "#2b2d31",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
        }}
      >
        <div
          style={{
            height: 48,
            display: "flex",
            alignItems: "center",
            padding: "0 16px",
            borderBottom: "1px solid #1e1f22",
            color: "#fff",
            fontWeight: 700,
            fontSize: 15,
            boxShadow: "0 1px 0 rgba(0,0,0,0.2)",
          }}
        >
          우리 서버
        </div>

        <div style={{ flex: 1, padding: "12px 8px", overflowY: "auto" }}>
          <div
            style={{
              color: "#949ba4",
              fontSize: 12,
              fontWeight: 700,
              padding: "0 8px",
              marginBottom: 6,
              textTransform: "uppercase",
            }}
          >
            텍스트 채널
          </div>
          {channels.map((c) => (
            <div
              key={c.id}
              onClick={() => setActiveChannel(c.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "7px 8px",
                borderRadius: 4,
                marginBottom: 2,
                cursor: "pointer",
                background: activeChannel === c.id ? "#3f4248" : "transparent",
                color: activeChannel === c.id ? "#fff" : "#949ba4",
                fontSize: 15,
                fontWeight: 500,
              }}
            >
              <span style={{ color: "#80848e", fontSize: 18 }}>#</span>
              {c.name}
            </div>
          ))}
        </div>

        {isAdmin && (
          <div style={{ padding: 8 }}>
            <button
              onClick={() => setShowAdmin(true)}
              style={{
                width: "100%",
                padding: "9px 0",
                borderRadius: 4,
                border: "none",
                background: "#3f4147",
                color: "#dbdee1",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              🛡️ 관리자 패널
            </button>
          </div>
        )}

        {/* 유저 패널 */}
        <div
          style={{
            height: 52,
            background: "#232428",
            display: "flex",
            alignItems: "center",
            padding: "0 8px",
            gap: 8,
          }}
        >
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: "50%",
              background: avatarColor(currentUser),
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 700,
              fontSize: 13,
              flexShrink: 0,
            }}
          >
            {initials(currentUser)}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ color: "#fff", fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {currentUser}
            </div>
            <div style={{ color: "#949ba4", fontSize: 11 }}>
              {isAdmin ? "관리자" : "온라인"}
            </div>
          </div>
        </div>
      </div>

      {/* 채팅 영역 */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div
          style={{
            height: 48,
            display: "flex",
            alignItems: "center",
            padding: "0 16px",
            borderBottom: "1px solid #26272b",
            color: "#fff",
            fontWeight: 700,
            fontSize: 15,
            boxShadow: "0 1px 0 rgba(0,0,0,0.2)",
            flexShrink: 0,
          }}
        >
          <span style={{ color: "#80848e", fontSize: 20, marginRight: 6 }}>#</span>
          {channelName}
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
          {loadingChannels && (
            <div style={{ color: "#6d6f78", fontSize: 14, marginTop: 20 }}>불러오는 중...</div>
          )}
          {!loadingChannels && messages.length === 0 && (
            <div style={{ color: "#6d6f78", fontSize: 14, marginTop: 20 }}>
              아직 메시지가 없습니다. 첫 메시지를 보내보세요!
            </div>
          )}
          {messages.map((m) => (
            <div key={m.id} style={{ display: "flex", gap: 12, marginTop: 16 }}>
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: "50%",
                  background: avatarColor(m.author),
                  color: "#fff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: 700,
                  fontSize: 14,
                  flexShrink: 0,
                }}
              >
                {initials(m.author)}
              </div>
              <div style={{ minWidth: 0 }}>
                <div>
                  <span style={{ color: "#fff", fontWeight: 600, fontSize: 15 }}>{m.author}</span>
                  <span style={{ color: "#949ba4", fontSize: 12, marginLeft: 8 }}>
                    {formatTime(m.created_at)}
                  </span>
                </div>
                <div style={{ color: "#dbdee1", fontSize: 15, marginTop: 2, wordBreak: "break-word" }}>
                  {m.text}
                </div>
              </div>
            </div>
          ))}
          {connError && (
            <div style={{ color: "#ed4245", fontSize: 12, marginTop: 10 }}>{connError}</div>
          )}
          <div ref={bottomRef} />
        </div>

        <div style={{ padding: "0 16px 24px" }}>
          <div
            style={{
              background: "#383a40",
              borderRadius: 8,
              display: "flex",
              alignItems: "center",
              padding: "0 12px",
            }}
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendMessage()}
              placeholder={`#${channelName}에 메시지 보내기`}
              style={{
                flex: 1,
                background: "transparent",
                border: "none",
                outline: "none",
                color: "#dbdee1",
                fontSize: 15,
                padding: "11px 0",
              }}
            />
            <button
              onClick={sendMessage}
              style={{
                background: "transparent",
                border: "none",
                color: input.trim() ? "#5865F2" : "#4e5058",
                fontWeight: 700,
                fontSize: 13,
                cursor: input.trim() ? "pointer" : "default",
                padding: "6px 4px",
              }}
            >
              전송
            </button>
          </div>
        </div>
      </div>

      {showAdmin && (
        <AdminPanel onClose={() => setShowAdmin(false)} />
      )}
    </div>
  );
}

// ---------- 설정 안내 화면 (SUPABASE_URL/KEY 미입력 시) ----------
function NotConfiguredScreen() {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#1e1f22",
        color: "#dbdee1",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif",
        padding: 24,
        textAlign: "center",
      }}
    >
      <div style={{ maxWidth: 480 }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: "#fff", marginBottom: 10 }}>
          Supabase 설정이 필요합니다
        </div>
        <div style={{ fontSize: 14, lineHeight: 1.6, color: "#949ba4" }}>
          코드 상단의 <code>SUPABASE_URL</code>과 <code>SUPABASE_ANON_KEY</code> 값을
          본인의 Supabase 프로젝트 값으로 바꿔주세요. (Project Settings → API 에서 확인)
        </div>
      </div>
    </div>
  );
}

// ---------- 최상위 앱 ----------
export default function App() {
  const [stage, setStage] = useState("gate"); // gate -> licensePrompt -> killed -> chat -> checking
  const [licenseError, setLicenseError] = useState(false);
  const [licenseErrorMsg, setLicenseErrorMsg] = useState("");
  const [currentUser, setCurrentUser] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);

  if (!CONFIGURED) return <NotConfiguredScreen />;

  function handleUnlockAttempt() {
    setLicenseError(false);
    setStage("licensePrompt");
  }

  async function handleLicenseSubmit(code) {
    if (!code) return;
    setStage("checking");
    try {
      const rows = await sbSelect(
        "whitelist",
        `code=eq.${encodeURIComponent(code)}&select=name,code,is_admin`
      );
      if (rows.length > 0) {
        const match = rows[0];
        setCurrentUser(match.name);
        setIsAdmin(Boolean(match.is_admin));
        setStage("chat");
      } else {
        // 코드가 틀리면 접속 종료
        setStage("killed");
      }
    } catch (e) {
      setLicenseError(true);
      setLicenseErrorMsg(`연결 실패: ${e.message}`);
      setStage("licensePrompt");
    }
  }

  if (stage === "killed") return <KilledScreen />;

  if (stage === "chat") {
    return <ChatMain currentUser={currentUser} isAdmin={isAdmin} />;
  }

  return (
    <>
      <FakeNotFound onUnlock={handleUnlockAttempt} />
      {(stage === "licensePrompt" || stage === "checking") && (
        <LicenseModal
          onSubmit={handleLicenseSubmit}
          error={licenseError}
          errorMsg={licenseErrorMsg}
          checking={stage === "checking"}
          onClose={() => setStage("gate")}
        />
      )}
    </>
  );
}
