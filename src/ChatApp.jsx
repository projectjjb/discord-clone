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

async function sbDelete(table, filterQuery) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?apikey=${SUPABASE_ANON_KEY}&${filterQuery}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: SB_HEADERS,
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`${table} 삭제 실패: ${res.status} ${err}`);
  }
}

async function sbUpdate(table, filterQuery, body) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?apikey=${SUPABASE_ANON_KEY}&${filterQuery}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { ...SB_HEADERS, Prefer: "return=representation" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`${table} 업데이트 실패: ${res.status} ${err}`);
  }
  const rows = await res.json();
  // RLS 정책 때문에 0개 행이 수정되면 에러 없이 빈 배열이 오므로 직접 감지
  if (Array.isArray(rows) && rows.length === 0) {
    throw new Error(`${table} 업데이트가 적용되지 않았습니다 (권한 정책 확인 필요)`);
  }
  return rows;
}

// 화이트리스트(프로필) 변경을 실시간으로 구독
function subscribeToProfiles(onChange) {
  const wsUrl =
    SUPABASE_URL.replace("https://", "wss://") +
    `/realtime/v1/websocket?apikey=${SUPABASE_ANON_KEY}&vsn=1.0.0`;
  const ws = new WebSocket(wsUrl);
  let ref = 1;

  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        topic: "realtime:public:whitelist",
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
      if ((msg.event === "UPDATE" || msg.event === "INSERT") && msg.payload?.record) {
        onChange(msg.payload.record);
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

function subscribeToMessages(onInsert, onUpdate, onDelete) {
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
      } else if (msg.event === "UPDATE" && msg.payload?.record) {
        onUpdate?.(msg.payload.record);
      } else if (msg.event === "DELETE" && msg.payload?.old_record) {
        onDelete?.(msg.payload.old_record);
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

// 이미지를 Supabase Storage(chat-images 버킷)에 업로드하고 공개 URL을 반환
// 이미지를 브라우저에서 리사이즈+압축 (용량을 크게 줄여 Storage 한도를 아낌)
const MAX_IMAGE_DIMENSION = 1600; // 긴 변 기준 최대 px
const JPEG_QUALITY = 0.8;

async function compressImage(file) {
  // GIF는 움직이는 이미지가 깨질 수 있어 압축하지 않고 그대로 전송
  if (file.type === "image/gif") return file;

  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const targetW = Math.round(bitmap.width * scale);
  const targetH = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, targetW, targetH);

  // PNG는 투명도를 지키기 위해 png로, 그 외엔 용량이 작은 jpeg로 재인코딩
  const outputType = file.type === "image/png" ? "image/png" : "image/jpeg";

  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, outputType, JPEG_QUALITY)
  );

  if (!blob || blob.size >= file.size) return file; // 압축이 더 크면 원본 사용
  const ext = outputType === "image/png" ? "png" : "jpg";
  return new File([blob], `compressed.${ext}`, { type: outputType });
}

async function uploadImage(file) {
  const ext = file.name.split(".").pop() || "png";
  const path = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const url = `${SUPABASE_URL}/storage/v1/object/chat-images/${path}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": file.type || "application/octet-stream",
    },
    body: file,
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`이미지 업로드 실패: ${res.status} ${err}`);
  }

  return `${SUPABASE_URL}/storage/v1/object/public/chat-images/${path}`;
}

// 이미지 파일 유효성 검사 (용량/타입 제한)
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB
const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

function validateImageFile(file) {
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    return "지원하지 않는 파일 형식입니다 (PNG, JPG, GIF, WEBP만 가능)";
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return "파일이 너무 큽니다 (최대 8MB)";
  }
  return null;
}

// ---------- Storage 용량 관리 ----------
const STORAGE_LIMIT_BYTES = 1024 * 1024 * 1024; // Supabase 무료 티어 1GB
const CLEANUP_THRESHOLD = 0.9; // 90% 넘으면 오래된 이미지부터 정리

// chat-images 버킷의 전체 파일 목록(이름, 용량, 생성일)을 가져옴
async function listAllImages() {
  const url = `${SUPABASE_URL}/storage/v1/object/list/chat-images`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prefix: "",
      limit: 1000,
      offset: 0,
      sortBy: { column: "created_at", order: "asc" },
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`${res.status} ${errText}`);
  }
  return res.json(); // [{ name, created_at, metadata: { size } }, ...]
}

async function deleteImageFromStorage(name) {
  const url = `${SUPABASE_URL}/storage/v1/object/chat-images/${name}`;
  await fetch(url, {
    method: "DELETE",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
  });
}

// 용량이 임계치를 넘으면 가장 오래된 이미지부터 지우고, 해당 메시지의 image_url도 비움
async function cleanupOldImagesIfNeeded() {
  try {
    const files = await listAllImages();
    const totalBytes = files.reduce((sum, f) => sum + (f.metadata?.size || 0), 0);
    if (totalBytes < STORAGE_LIMIT_BYTES * CLEANUP_THRESHOLD) return;

    // 가장 오래된 것부터, 용량이 임계치 아래로 내려갈 때까지 삭제
    let remaining = totalBytes;
    for (const f of files) {
      if (remaining < STORAGE_LIMIT_BYTES * CLEANUP_THRESHOLD) break;
      await deleteImageFromStorage(f.name);
      remaining -= f.metadata?.size || 0;
      // 해당 이미지를 참조하던 메시지에서 image_url 제거 (메시지 자체는 남기고 사진만 정리)
      const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/chat-images/${f.name}`;
      await sbUpdate("messages", `image_url=eq.${encodeURIComponent(publicUrl)}`, {
        image_url: null,
        text: "(오래되어 자동 삭제된 사진)",
      }).catch(() => {});
    }
  } catch (e) {
    // 정리 실패는 조용히 무시 (핵심 기능이 아니므로 채팅 자체를 막지 않음)
  }
}

// 현재 Storage 사용량을 조회 (바이트 단위)
async function getStorageUsage() {
  const files = await listAllImages();
  return files.reduce((sum, f) => sum + (f.metadata?.size || 0), 0);
}

// ---------- 데이터 ----------

const initialServers = [
  { id: "s1", name: "우리 서버", icon: "우" },
];

// 비밀번호를 평문 대신 해시로 저장하기 위한 함수
// (브라우저 내장 SHA-256 사용, 이름을 섞어 같은 비밀번호라도 다른 값이 나오게 함)
async function hashPassword(name, password) {
  const data = new TextEncoder().encode(`${name}::${password}::chatapp`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 10; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out.slice(0, 4) + "-" + out.slice(4, 8);
}

function initials(name) {
  return name?.trim()?.[0]?.toUpperCase() || "?";
}

// ---------- 이모지 리액션 ----------
const EMOJI_CHOICES = ["👍", "❤️", "🤣", "😮", "😢", "🔥", "🎉", "👀", "🤔", "🖕", "♿", "‼️", "❓", "6️⃣", "7️⃣"];

function EmojiPicker({ onPick, onClose, align = "left" }) {
  const ref = useRef(null);
  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={{
        position: "absolute",
        bottom: "100%",
        [align === "right" ? "right" : "left"]: 0,
        marginBottom: 6,
        background: "#2b2d31",
        borderRadius: 8,
        padding: 8,
        display: "grid",
        gridTemplateColumns: "repeat(6, 1fr)",
        gap: 2,
        width: "max-content",
        boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
        zIndex: 30,
      }}
    >
      {EMOJI_CHOICES.map((emoji) => (
        <button
          key={emoji}
          onClick={() => onPick(emoji)}
          style={{
            background: "transparent",
            border: "none",
            fontSize: 20,
            cursor: "pointer",
            padding: "6px 8px",
            borderRadius: 4,
            lineHeight: 1,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "#3f4147")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}

// 리액션 집계: [{emoji, count, reactedByMe}] 형태로 변환
function summarizeReactions(reactions, currentUser) {
  if (!reactions || typeof reactions !== "object") return [];
  return Object.entries(reactions)
    .map(([emoji, users]) => ({
      emoji,
      count: Array.isArray(users) ? users.length : 0,
      reactedByMe: Array.isArray(users) && users.includes(currentUser),
    }))
    .filter((r) => r.count > 0);
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
function LicenseModal({ onSubmitCode, onSubmitPassword, error, errorMsg, checking, onClose }) {
  const [mode, setMode] = useState("password"); // "password" | "license"
  const [code, setCode] = useState("");
  const [loginName, setLoginName] = useState("");
  const [loginPw, setLoginPw] = useState("");
  const firstInputRef = useRef(null);

  useEffect(() => {
    firstInputRef.current?.focus();
  }, [mode]);

  const inputStyle = {
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
  };

  const labelStyle = {
    color: "#b5bac1",
    fontSize: 12,
    fontWeight: 700,
    textTransform: "uppercase",
  };

  function submit() {
    if (checking) return;
    if (mode === "license") {
      onSubmitCode(code.trim());
    } else {
      onSubmitPassword(loginName.trim(), loginPw);
    }
  }

  function tabStyle(active) {
    return {
      flex: 1,
      padding: "9px 0",
      background: active ? "#404249" : "transparent",
      color: active ? "#fff" : "#949ba4",
      border: "none",
      borderRadius: 4,
      fontSize: 13,
      fontWeight: 600,
      cursor: "pointer",
    };
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
        <div style={{ textAlign: "center", marginBottom: 18 }}>
          <div style={{ color: "#fff", fontSize: 20, fontWeight: 700 }}>로그인</div>
        </div>

        <div style={{ display: "flex", gap: 4, background: "#1e1f22", padding: 4, borderRadius: 6 }}>
          <button onClick={() => setMode("password")} style={tabStyle(mode === "password")}>
            비밀번호로 로그인
          </button>
          <button onClick={() => setMode("license")} style={tabStyle(mode === "license")}>
            라이선스 코드
          </button>
        </div>

        {mode === "license" ? (
          <div style={{ marginTop: 18 }}>
            <label style={labelStyle}>License Code</label>
            <input
              ref={firstInputRef}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder="XXXX-XXXX"
              disabled={checking}
              style={inputStyle}
            />
            <div style={{ color: "#949ba4", fontSize: 12, marginTop: 6 }}>
              처음 접속하거나 비밀번호를 잊었다면 관리자에게 받은 코드로 들어오세요.
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 18 }}>
            <label style={labelStyle}>이름</label>
            <input
              ref={firstInputRef}
              value={loginName}
              onChange={(e) => setLoginName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder="관리자에게 받은 이름"
              disabled={checking}
              style={inputStyle}
            />
            <label style={{ ...labelStyle, display: "block", marginTop: 14 }}>비밀번호</label>
            <input
              type="password"
              value={loginPw}
              onChange={(e) => setLoginPw(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder="••••••••"
              disabled={checking}
              style={inputStyle}
            />
            <div style={{ color: "#949ba4", fontSize: 12, marginTop: 8, lineHeight: 1.5 }}>
              비밀번호는 접속 후 왼쪽 아래 <b style={{ color: "#dbdee1" }}>🔑 비밀번호 설정</b>에서
              정할 수 있어요. 아직 안 정했다면 라이선스 코드 탭으로 들어오세요.
            </div>
          </div>
        )}

        {error && (
          <div style={{ color: "#ed4245", fontSize: 13, marginTop: 10 }}>
            {errorMsg || "정보가 올바르지 않습니다."}
          </div>
        )}

        <button
          onClick={submit}
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

// ---------- 프로필 / 닉네임 설정 ----------
// ---------- 저장공간 게이지 ----------
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
}

function StorageGauge({ usageBytes }) {
  if (usageBytes == null) return null;
  const ratio = Math.min(1, usageBytes / STORAGE_LIMIT_BYTES);
  const percent = Math.round(ratio * 100);
  const barColor = ratio > 0.9 ? "#ed4245" : ratio > 0.7 ? "#faa61a" : "#3ba55d";

  return (
    <div style={{ padding: "10px 12px", borderTop: "1px solid #1e1f22" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          color: "#949ba4",
          fontSize: 11,
          marginBottom: 4,
        }}
      >
        <span>사진 저장공간</span>
        <span>
          {formatBytes(usageBytes)} / {formatBytes(STORAGE_LIMIT_BYTES)}
        </span>
      </div>
      <div style={{ background: "#1e1f22", borderRadius: 4, height: 6, overflow: "hidden" }}>
        <div
          style={{
            width: `${percent}%`,
            height: "100%",
            background: barColor,
            transition: "width 0.3s",
          }}
        />
      </div>
    </div>
  );
}

// 프로필 아바타로 고를 수 있는 색상 팔레트
const AVATAR_COLORS = [
  "#5865F2", "#EB459E", "#57F287", "#FEE75C", "#ED4245",
  "#9B59B6", "#3BA55D", "#E67E22", "#1ABC9C", "#95A5A6",
];

function ProfileModal({ currentUser, nickname, currentColor, onSave, onClose }) {
  const [value, setValue] = useState(nickname || "");
  const [color, setColor] = useState(currentColor || avatarColor(currentUser));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    const ok = await onSave(value, color);
    setSaving(false);
    if (ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
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
          width: 420,
          maxWidth: "90vw",
          padding: "28px 26px",
          boxShadow: "0 8px 40px rgba(0,0,0,0.5)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: "50%",
              background: color,
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 700,
              fontSize: 20,
              flexShrink: 0,
            }}
          >
            {initials(value || currentUser)}
          </div>
          <div>
            <div style={{ color: "#fff", fontSize: 18, fontWeight: 700 }}>
              {value || currentUser}
            </div>
            <div style={{ color: "#949ba4", fontSize: 13 }}>@{currentUser}</div>
          </div>
        </div>

        <label style={{ color: "#b5bac1", fontSize: 12, fontWeight: 700, textTransform: "uppercase" }}>
          닉네임
        </label>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSave()}
          placeholder={currentUser}
          maxLength={20}
          style={{
            width: "100%",
            marginTop: 6,
            padding: "10px 12px",
            borderRadius: 4,
            border: "none",
            outline: "none",
            background: "#1e1f22",
            color: "#fff",
            fontSize: 15,
            boxSizing: "border-box",
          }}
        />
        <div style={{ color: "#949ba4", fontSize: 12, marginTop: 6 }}>
          채팅에는 닉네임이 표시되고, 원래 이름(@{currentUser})은 프로필에서만 보여요. 비워두면 원래 이름이 그대로 표시돼요.
        </div>

        <label
          style={{
            color: "#b5bac1",
            fontSize: 12,
            fontWeight: 700,
            textTransform: "uppercase",
            display: "block",
            marginTop: 18,
          }}
        >
          프로필 색상
        </label>
        <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
          {AVATAR_COLORS.map((c) => (
            <button
              key={c}
              onClick={() => setColor(c)}
              title={c}
              style={{
                width: 32,
                height: 32,
                borderRadius: "50%",
                background: c,
                border: color === c ? "3px solid #fff" : "3px solid transparent",
                cursor: "pointer",
                padding: 0,
              }}
            />
          ))}
        </div>

        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            width: "100%",
            marginTop: 18,
            padding: "11px 0",
            borderRadius: 4,
            border: "none",
            background: saving ? "#454a52" : "#5865F2",
            color: "#fff",
            fontWeight: 600,
            fontSize: 15,
            cursor: saving ? "default" : "pointer",
          }}
        >
          {saving ? "저장 중..." : saved ? "저장됨 ✓" : "프로필 저장"}
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
          닫기
        </div>
      </div>
    </div>
  );
}

// ---------- 비밀번호 설정 / 변경 ----------
function PasswordSettingsModal({ currentUser, currentCode, onClose }) {
  const [hasPassword, setHasPassword] = useState(null); // null = 확인 중
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [newPw2, setNewPw2] = useState("");
  const [msg, setMsg] = useState("");
  const [isError, setIsError] = useState(false);
  const [saving, setSaving] = useState(false);

  // 이미 비밀번호가 설정되어 있는지 확인
  useEffect(() => {
    let cancelled = false;
    sbSelect("whitelist", `code=eq.${encodeURIComponent(currentCode)}&select=password_hash`)
      .then((rows) => {
        if (!cancelled) setHasPassword(Boolean(rows[0]?.password_hash));
      })
      .catch(() => {
        if (!cancelled) setHasPassword(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentCode]);

  async function handleSave() {
    setMsg("");
    setIsError(false);

    if (newPw.length < 4) {
      setIsError(true);
      setMsg("비밀번호는 4자 이상으로 해주세요.");
      return;
    }
    if (newPw !== newPw2) {
      setIsError(true);
      setMsg("새 비밀번호가 서로 다릅니다.");
      return;
    }

    setSaving(true);
    try {
      // 이미 비밀번호가 있으면 기존 비밀번호를 먼저 확인
      if (hasPassword) {
        const rows = await sbSelect(
          "whitelist",
          `code=eq.${encodeURIComponent(currentCode)}&select=password_hash`
        );
        const oldHash = await hashPassword(currentUser, oldPw);
        if (oldHash !== rows[0]?.password_hash) {
          setIsError(true);
          setMsg("현재 비밀번호가 올바르지 않습니다.");
          setSaving(false);
          return;
        }
      }

      const hash = await hashPassword(currentUser, newPw);
      await sbUpdate("whitelist", `code=eq.${encodeURIComponent(currentCode)}`, {
        password_hash: hash,
      });
      setHasPassword(true);
      setOldPw("");
      setNewPw("");
      setNewPw2("");
      setIsError(false);
      setMsg("비밀번호가 저장되었습니다 ✓");
    } catch (e) {
      setIsError(true);
      setMsg(`저장 실패: ${e.message}`);
    } finally {
      setSaving(false);
    }
  }

  const inputStyle = {
    width: "100%",
    marginTop: 6,
    padding: "10px 12px",
    borderRadius: 4,
    border: "none",
    outline: "none",
    background: "#1e1f22",
    color: "#fff",
    fontSize: 15,
    boxSizing: "border-box",
  };

  const labelStyle = {
    color: "#b5bac1",
    fontSize: 12,
    fontWeight: 700,
    display: "block",
  };

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
          width: 420,
          maxWidth: "90vw",
          padding: "28px 26px",
          boxShadow: "0 8px 40px rgba(0,0,0,0.5)",
        }}
      >
        <div style={{ color: "#fff", fontSize: 18, fontWeight: 700 }}>
          {hasPassword ? "비밀번호 변경" : "비밀번호 설정"}
        </div>
        <div style={{ color: "#949ba4", fontSize: 13, marginTop: 6 }}>
          로그인할 때 <b style={{ color: "#dbdee1" }}>{currentUser}</b> + 비밀번호로 들어올 수 있어요.
        </div>

        {hasPassword && (
          <div style={{ marginTop: 18 }}>
            <label style={labelStyle}>현재 비밀번호</label>
            <input
              type="password"
              value={oldPw}
              onChange={(e) => setOldPw(e.target.value)}
              placeholder="현재 비밀번호"
              style={inputStyle}
            />
          </div>
        )}

        <div style={{ marginTop: 14 }}>
          <label style={labelStyle}>{hasPassword ? "새 비밀번호" : "비밀번호"}</label>
          <input
            type="password"
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
            placeholder="4자 이상"
            style={inputStyle}
          />
        </div>

        <div style={{ marginTop: 14 }}>
          <label style={labelStyle}>비밀번호 확인</label>
          <input
            type="password"
            value={newPw2}
            onChange={(e) => setNewPw2(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSave()}
            placeholder="다시 입력"
            style={inputStyle}
          />
        </div>

        <div
          style={{
            background: "rgba(237, 66, 69, 0.1)",
            border: "1px solid rgba(237, 66, 69, 0.4)",
            borderRadius: 6,
            padding: "12px 14px",
            marginTop: 16,
            color: "#f5a3a5",
            fontSize: 12,
            lineHeight: 1.6,
          }}
        >
          <div style={{ color: "#ed4245", fontWeight: 700, fontSize: 13, marginBottom: 6 }}>
            ⚠️ 주의
          </div>
          평소 쓰는 비밀번호를 절대 쓰지 마세요. 이 사이트는 친구들끼리 쓰려고 간단히 만든 거라
          보안이 약하고, 저장된 비밀번호가 유출될 수 있어요.
          <b style={{ color: "#f5a3a5" }}> 아무 의미 없는 새 비밀번호</b>로 정해주세요.
          (예: 게임 캐릭터 이름 + 아무 숫자)
        </div>

        {msg && (
          <div
            style={{
              color: isError ? "#ed4245" : "#3ba55d",
              fontSize: 13,
              marginTop: 10,
            }}
          >
            {msg}
          </div>
        )}

        <button
          onClick={handleSave}
          disabled={saving || hasPassword === null}
          style={{
            width: "100%",
            marginTop: 18,
            padding: "11px 0",
            borderRadius: 4,
            border: "none",
            background: saving ? "#454a52" : "#5865F2",
            color: "#fff",
            fontWeight: 600,
            fontSize: 15,
            cursor: saving ? "default" : "pointer",
          }}
        >
          {saving ? "저장 중..." : hasPassword ? "비밀번호 변경" : "비밀번호 설정"}
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
          닫기
        </div>
      </div>
    </div>
  );
}

// ---------- 관리자: 화이트리스트 패널 ----------
function AdminPanel({ currentCode, onClose }) {
  const [name, setName] = useState("");
  const [whitelist, setWhitelist] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let cancelled = false;
    sbSelect("whitelist", "select=id,name,code,nickname,is_admin&order=id.desc")
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

  async function deleteUser(user) {
    if (user.code === currentCode) {
      setErr("지금 로그인 중인 본인 계정은 삭제할 수 없습니다.");
      return;
    }
    if (
      !window.confirm(
        `'${user.name}'을(를) 화이트리스트에서 삭제할까요?\n이 코드로는 더 이상 접속할 수 없게 됩니다.`
      )
    )
      return;

    setDeletingId(user.id);
    setErr("");
    const backup = whitelist;
    setWhitelist((prev) => prev.filter((u) => u.id !== user.id)); // 낙관적 삭제
    try {
      await sbDelete("whitelist", `id=eq.${user.id}`);
    } catch (e) {
      setErr(`삭제 실패: ${e.message}`);
      setWhitelist(backup); // 실패 시 되돌림
    } finally {
      setDeletingId(null);
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
              <div style={{ minWidth: 0 }}>
                <div style={{ color: "#fff", fontSize: 14, fontWeight: 600 }}>
                  {u.name}
                  {u.nickname && (
                    <span style={{ color: "#949ba4", fontWeight: 400 }}> ({u.nickname})</span>
                  )}
                  {u.is_admin && (
                    <span style={{ color: "#faa61a", fontSize: 11, marginLeft: 6 }}>관리자</span>
                  )}
                  {u.code === currentCode && (
                    <span style={{ color: "#3ba55d", fontSize: 11, marginLeft: 6 }}>나</span>
                  )}
                </div>
                <div style={{ color: "#949ba4", fontSize: 12, marginTop: 2, fontFamily: "monospace" }}>
                  {u.code}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
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
                <button
                  onClick={() => deleteUser(u)}
                  disabled={deletingId === u.id || u.code === currentCode}
                  title={u.code === currentCode ? "본인 계정은 삭제할 수 없습니다" : "삭제"}
                  style={{
                    background: u.code === currentCode ? "#3a3c41" : "#4a2326",
                    border: "none",
                    color: u.code === currentCode ? "#6d6f78" : "#ed4245",
                    fontSize: 12,
                    padding: "6px 10px",
                    borderRadius: 4,
                    cursor: u.code === currentCode ? "not-allowed" : "pointer",
                  }}
                >
                  {deletingId === u.id ? "삭제 중..." : "삭제"}
                </button>
              </div>
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
function ChatMain({ currentUser, currentCode, nickname, onNicknameChange, isAdmin }) {
  const [channels, setChannels] = useState([]);
  const [activeChannel, setActiveChannel] = useState(null);
  const [showAdmin, setShowAdmin] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [profileMap, setProfileMap] = useState({}); // { 원래이름: { nickname, avatar_color } }
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([]);
  const [loadingChannels, setLoadingChannels] = useState(true);
  const [connError, setConnError] = useState("");
  const [storageUsage, setStorageUsage] = useState(null); // 바이트 단위, null이면 아직 로드 전
  const [serverName, setServerName] = useState("우리 서버");
  const [editingServerName, setEditingServerName] = useState(false);
  const [serverNameDraft, setServerNameDraft] = useState("");
  const [myColor, setMyColor] = useState(null);

  // 전체 사용자 프로필(닉네임/색상) 로드 — 다른 사람이 바꾼 것도 반영되도록 주기적으로 갱신
  function refreshProfiles() {
    sbSelect("whitelist", "select=name,nickname,avatar_color")
      .then((rows) => {
        const map = {};
        rows.forEach((r) => {
          map[r.name] = { nickname: r.nickname, avatar_color: r.avatar_color };
        });
        setProfileMap(map);
        const mine = rows.find((r) => r.name === currentUser);
        if (mine?.avatar_color) setMyColor(mine.avatar_color);
      })
      .catch(() => {});
  }

  useEffect(() => {
    refreshProfiles();
    // 실시간 구독: 누군가 닉네임/색상을 바꾸면 즉시 반영
    const unsubscribe = subscribeToProfiles((record) => {
      setProfileMap((prev) => ({
        ...prev,
        [record.name]: { nickname: record.nickname, avatar_color: record.avatar_color },
      }));
      if (record.name === currentUser && record.avatar_color) {
        setMyColor(record.avatar_color);
      }
    });
    // 실시간 연결이 끊겼을 때를 대비한 백업 폴링
    const interval = setInterval(refreshProfiles, 30000);
    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, [currentUser]);

  function displayName(originalName) {
    return profileMap[originalName]?.nickname || originalName;
  }

  function userColor(originalName) {
    return profileMap[originalName]?.avatar_color || avatarColor(originalName);
  }

  const [pendingImage, setPendingImage] = useState(null); // { file, previewUrl }
  const [uploading, setUploading] = useState(false);
  const [openPickerFor, setOpenPickerFor] = useState(null); // 이모지 피커가 열린 메시지 id
  const [hoveredMsg, setHoveredMsg] = useState(null);
  const [showInputEmojiPicker, setShowInputEmojiPicker] = useState(false);

  const bottomRef = useRef(null);
  const fileInputRef = useRef(null);

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

  // 서버 이름 로드 + 주기적 갱신 (다른 사람이 바꾼 것도 반영)
  useEffect(() => {
    let cancelled = false;
    function loadServerName() {
      sbSelect("server_settings", "select=server_name&id=eq.1")
        .then((rows) => {
          if (!cancelled && rows.length > 0) setServerName(rows[0].server_name);
        })
        .catch(() => {});
    }
    loadServerName();
    const interval = setInterval(loadServerName, 15000); // 15초마다
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  async function saveServerName() {
    const trimmed = serverNameDraft.trim();
    if (!trimmed) {
      setEditingServerName(false);
      return;
    }
    setServerName(trimmed); // 낙관적 업데이트
    setEditingServerName(false);
    try {
      await sbUpdate("server_settings", "id=eq.1", { server_name: trimmed });
    } catch (e) {
      setConnError("서버 이름 저장 실패.");
    }
  }

  function refreshStorageUsage() {
    getStorageUsage()
      .then((bytes) => setStorageUsage(bytes))
      .catch((e) => setConnError(`용량 조회 실패: ${e.message}`));
  }

  // 용량 게이지: 최초 로드 + 1분마다 갱신 (모두의 화면에 최신 상태가 보이도록)
  useEffect(() => {
    refreshStorageUsage();
    const interval = setInterval(refreshStorageUsage, 60000);
    return () => clearInterval(interval);
  }, []);

  // 채널 바뀔 때마다 해당 채널 메시지 로드
  useEffect(() => {
    if (activeChannel == null) return;
    let cancelled = false;
    sbSelect(
      "messages",
      `channel_id=eq.${activeChannel}&select=id,author,text,image_url,reactions,created_at&order=created_at.asc`
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
    const unsubscribe = subscribeToMessages(
      (record) => {
        setMessages((prev) => {
          if (record.channel_id !== activeChannel) return prev;
          if (prev.some((m) => m.id === record.id)) return prev; // 중복 방지(내가 보낸 것 이미 반영된 경우)
          return [...prev, record];
        });
      },
      (record) => {
        // 리액션 변경 등 업데이트 반영
        setMessages((prev) => prev.map((m) => (m.id === record.id ? { ...m, ...record } : m)));
      },
      (oldRecord) => {
        // 삭제 반영
        setMessages((prev) => prev.filter((m) => m.id !== oldRecord.id));
      }
    );
    return unsubscribe;
  }, [activeChannel]);

  const scrollToBottom = (smooth = true) => {
    bottomRef.current?.scrollIntoView({ behavior: smooth ? "smooth" : "auto" });
  };

  // 메시지가 바뀌면 맨 아래로. 약간의 지연을 줘서 렌더링 완료 후 스크롤
  useEffect(() => {
    scrollToBottom(true);
    const t = setTimeout(() => scrollToBottom(false), 100);
    return () => clearTimeout(t);
  }, [messages]);

  // 채널을 새로 열면 즉시 맨 아래로 (부드러운 애니메이션 없이 바로)
  useEffect(() => {
    const t = setTimeout(() => scrollToBottom(false), 50);
    return () => clearTimeout(t);
  }, [activeChannel]);

  // 이미지 정리 (미리보기 URL 메모리 해제)
  useEffect(() => {
    return () => {
      if (pendingImage?.previewUrl) URL.revokeObjectURL(pendingImage.previewUrl);
    };
  }, [pendingImage]);

  function handleFileSelect(e) {
    const file = e.target.files?.[0];
    e.target.value = ""; // 같은 파일 다시 선택 가능하도록 초기화
    if (!file) return;
    const err = validateImageFile(file);
    if (err) {
      setConnError(err);
      return;
    }
    setConnError("");
    setPendingImage({ file, previewUrl: URL.createObjectURL(file) });
  }

  function cancelPendingImage() {
    if (pendingImage?.previewUrl) URL.revokeObjectURL(pendingImage.previewUrl);
    setPendingImage(null);
  }

  async function sendMessage() {
    const text = input.trim();
    if ((!text && !pendingImage) || activeChannel == null || uploading) return;

    let imageUrl = null;
    const imageToSend = pendingImage;
    setInput("");
    setPendingImage(null);

    // 낙관적 업데이트: 내 화면엔 바로 표시 (이미지는 로컬 미리보기 사용)
    const tempId = `temp-${Date.now()}`;
    const optimistic = {
      id: tempId,
      author: currentUser,
      text,
      image_url: imageToSend?.previewUrl || null,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);

    try {
      if (imageToSend) {
        setUploading(true);
        const compressed = await compressImage(imageToSend.file);
        imageUrl = await uploadImage(compressed);
      }
      const [saved] = await sbInsert("messages", {
        channel_id: activeChannel,
        author: currentUser,
        text: text || "",
        image_url: imageUrl,
      });
      setMessages((prev) => prev.map((m) => (m.id === tempId ? saved : m)));
      if (imageUrl) {
        // 사진을 보낸 김에 용량 체크 (임계치 넘으면 오래된 사진부터 자동 정리)
        cleanupOldImagesIfNeeded();
        refreshStorageUsage();
      }
    } catch (e) {
      setConnError(e.message || "메시지 전송 실패. 다시 시도해주세요.");
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
    } finally {
      setUploading(false);
      if (imageToSend?.previewUrl) URL.revokeObjectURL(imageToSend.previewUrl);
    }
  }

  const channelName = channels.find((c) => c.id === activeChannel)?.name || "";

  async function deleteMessage(msg) {
    if (!window.confirm("이 메시지를 삭제할까요?")) return;
    // 낙관적 삭제
    setMessages((prev) => prev.filter((m) => m.id !== msg.id));
    try {
      await sbDelete("messages", `id=eq.${msg.id}`);
    } catch (e) {
      setConnError("삭제 실패. 다시 시도해주세요.");
      // 실패 시 되돌림
      setMessages((prev) => [...prev, msg].sort((a, b) => new Date(a.created_at) - new Date(b.created_at)));
    }
  }

  async function toggleReaction(msg, emoji) {
    setOpenPickerFor(null);
    const current = msg.reactions && typeof msg.reactions === "object" ? msg.reactions : {};
    const usersForEmoji = Array.isArray(current[emoji]) ? current[emoji] : [];
    const alreadyReacted = usersForEmoji.includes(currentUser);

    const nextUsers = alreadyReacted
      ? usersForEmoji.filter((u) => u !== currentUser)
      : [...usersForEmoji, currentUser];

    const nextReactions = { ...current };
    if (nextUsers.length > 0) {
      nextReactions[emoji] = nextUsers;
    } else {
      delete nextReactions[emoji];
    }

    // 낙관적 업데이트
    setMessages((prev) =>
      prev.map((m) => (m.id === msg.id ? { ...m, reactions: nextReactions } : m))
    );

    try {
      await sbUpdate("messages", `id=eq.${msg.id}`, { reactions: nextReactions });
    } catch (e) {
      setConnError("리액션 반영 실패.");
      // 실패 시 되돌림
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, reactions: current } : m)));
    }
  }

  async function saveProfile(newNickname, newColor) {
    const trimmed = newNickname.trim();
    try {
      await sbUpdate("whitelist", `code=eq.${encodeURIComponent(currentCode)}`, {
        nickname: trimmed || null,
        avatar_color: newColor || null,
      });
      onNicknameChange(trimmed);
      setMyColor(newColor || null);
      setProfileMap((prev) => ({
        ...prev,
        [currentUser]: { nickname: trimmed || null, avatar_color: newColor || null },
      }));
      return true;
    } catch (e) {
      setConnError(`프로필 저장 실패: ${e.message}`);
      return false;
    }
  }



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
        <div
          title={serverName}
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
          {serverName?.trim()?.[0] || "?"}
        </div>
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
          onClick={() => {
            if (!editingServerName) {
              setServerNameDraft(serverName);
              setEditingServerName(true);
            }
          }}
          title="클릭해서 서버 이름 수정"
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
            cursor: editingServerName ? "default" : "pointer",
          }}
        >
          {editingServerName ? (
            <input
              autoFocus
              value={serverNameDraft}
              onChange={(e) => setServerNameDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveServerName()}
              onBlur={saveServerName}
              maxLength={30}
              style={{
                width: "100%",
                background: "#1e1f22",
                border: "none",
                outline: "1px solid #5865F2",
                borderRadius: 4,
                color: "#fff",
                fontWeight: 700,
                fontSize: 15,
                padding: "4px 6px",
              }}
            />
          ) : (
            serverName
          )}
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

        <StorageGauge usageBytes={storageUsage} />

        <div style={{ padding: "8px 8px 0" }}>
          <button
            onClick={() => setShowPasswordModal(true)}
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
            🔑 비밀번호 설정
          </button>
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
          onClick={() => setShowProfile(true)}
          title="프로필 / 닉네임 설정"
          style={{
            height: 52,
            background: "#232428",
            display: "flex",
            alignItems: "center",
            padding: "0 8px",
            gap: 8,
            cursor: "pointer",
          }}
        >
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: "50%",
              background: userColor(currentUser),
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 700,
              fontSize: 13,
              flexShrink: 0,
            }}
          >
            {initials(displayName(currentUser))}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ color: "#fff", fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {displayName(currentUser)}
            </div>
            <div style={{ color: "#949ba4", fontSize: 11 }}>
              {isAdmin ? "관리자" : "온라인"}
            </div>
          </div>
        </div>
      </div>

      {showProfile && (
        <ProfileModal
          currentUser={currentUser}
          nickname={nickname}
          currentColor={myColor || avatarColor(currentUser)}
          onSave={saveProfile}
          onClose={() => setShowProfile(false)}
        />
      )}

      {showPasswordModal && (
        <PasswordSettingsModal
          currentUser={currentUser}
          currentCode={currentCode}
          onClose={() => setShowPasswordModal(false)}
        />
      )}

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
          {messages.map((m, idx) => {
            const prev = messages[idx - 1];
            const isGrouped =
              prev &&
              prev.author === m.author &&
              !prev.image_url === !m.image_url && // 그룹 여부와 무관하지만 안전하게 유지
              new Date(m.created_at) - new Date(prev.created_at) < 5 * 60 * 1000;

            const reactionList = summarizeReactions(m.reactions, currentUser);
            const canDelete = m.author === currentUser;
            const isHovered = hoveredMsg === m.id;
            const isPickerOpen = openPickerFor === m.id;
            const showToolbar = isHovered || isPickerOpen;

            return (
              <div
                key={m.id}
                onMouseEnter={() => setHoveredMsg(m.id)}
                onMouseLeave={() => setHoveredMsg(null)}
                style={{
                  display: "flex",
                  gap: 12,
                  marginTop: isGrouped ? 2 : 16,
                  padding: "2px 8px",
                  marginLeft: -8,
                  marginRight: -8,
                  borderRadius: 6,
                  background: isHovered ? "#2e3035" : "transparent",
                  position: "relative",
                }}
              >
                <div style={{ width: 40, flexShrink: 0 }}>
                  {!isGrouped && (
                    <div
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: "50%",
                        background: userColor(m.author),
                        color: "#fff",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontWeight: 700,
                        fontSize: 14,
                      }}
                    >
                      {initials(displayName(m.author))}
                    </div>
                  )}
                  {isGrouped && isHovered && (
                    <div style={{ color: "#949ba4", fontSize: 10, textAlign: "center", marginTop: 4 }}>
                      {formatTime(m.created_at)}
                    </div>
                  )}
                </div>

                <div style={{ minWidth: 0, flex: 1 }}>
                  {!isGrouped && (
                    <div>
                      <span style={{ color: "#fff", fontWeight: 600, fontSize: 15 }}>
                        {displayName(m.author)}
                      </span>
                      <span style={{ color: "#949ba4", fontSize: 12, marginLeft: 8 }}>
                        {formatTime(m.created_at)}
                      </span>
                    </div>
                  )}
                  {m.text && (
                    <div style={{ color: "#dbdee1", fontSize: 15, marginTop: isGrouped ? 0 : 2, wordBreak: "break-word" }}>
                      {m.text}
                    </div>
                  )}
                  {m.image_url && (
                    <img
                      src={m.image_url}
                      alt="첨부 이미지"
                      onClick={() => window.open(m.image_url, "_blank")}
                      onLoad={() => {
                        if (idx === messages.length - 1) scrollToBottom(false);
                      }}
                      style={{
                        marginTop: 6,
                        width: "100%",
                        maxWidth: 480,
                        minWidth: 220,
                        maxHeight: 480,
                        borderRadius: 8,
                        display: "block",
                        cursor: "pointer",
                        objectFit: "contain",
                        background: "#1e1f22",
                      }}
                    />
                  )}

                  {reactionList.length > 0 && (
                    <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                      {reactionList.map((r) => (
                        <button
                          key={r.emoji}
                          onClick={() => toggleReaction(m, r.emoji)}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 4,
                            background: r.reactedByMe ? "#3c4270" : "#2b2d31",
                            border: r.reactedByMe ? "1px solid #5865F2" : "1px solid transparent",
                            borderRadius: 10,
                            padding: "2px 8px",
                            fontSize: 13,
                            color: "#dbdee1",
                            cursor: "pointer",
                          }}
                        >
                          <span>{r.emoji}</span>
                          <span style={{ fontSize: 12 }}>{r.count}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {showToolbar && (
                  <div
                    onMouseEnter={() => setHoveredMsg(m.id)}
                    style={{
                      position: "absolute",
                      top: -14,
                      left: 52,
                      background: "#313338",
                      border: "1px solid #26272b",
                      borderRadius: 6,
                      display: "flex",
                      boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
                      zIndex: 20,
                    }}
                  >
                    <div style={{ position: "relative" }}>
                      <button
                        onClick={() => setOpenPickerFor(openPickerFor === m.id ? null : m.id)}
                        title="이모지 반응"
                        style={{
                          background: "transparent",
                          border: "none",
                          color: "#dbdee1",
                          fontSize: 15,
                          padding: "6px 9px",
                          cursor: "pointer",
                        }}
                      >
                        😀
                      </button>
                      {isPickerOpen && (
                        <EmojiPicker
                          align="left"
                          onPick={(emoji) => toggleReaction(m, emoji)}
                          onClose={() => setOpenPickerFor(null)}
                        />
                      )}
                    </div>
                    {canDelete && (
                      <button
                        onClick={() => deleteMessage(m)}
                        title="메시지 삭제"
                        style={{
                          background: "transparent",
                          border: "none",
                          color: "#ed4245",
                          fontSize: 15,
                          padding: "6px 9px",
                          cursor: "pointer",
                        }}
                      >
                        🗑️
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {connError && (
            <div style={{ color: "#ed4245", fontSize: 12, marginTop: 10 }}>{connError}</div>
          )}
          <div ref={bottomRef} />
        </div>

        <div style={{ padding: "0 16px 24px" }}>
          {pendingImage && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                background: "#2b2d31",
                borderRadius: 8,
                padding: 10,
                marginBottom: 8,
              }}
            >
              <img
                src={pendingImage.previewUrl}
                alt="첨부할 이미지 미리보기"
                style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 6 }}
              />
              <div style={{ flex: 1, color: "#dbdee1", fontSize: 13 }}>
                {pendingImage.file.name}
              </div>
              <button
                onClick={cancelPendingImage}
                style={{
                  background: "#3f4147",
                  border: "none",
                  color: "#dbdee1",
                  borderRadius: 4,
                  padding: "6px 10px",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                취소
              </button>
            </div>
          )}
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
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              onChange={handleFileSelect}
              style={{ display: "none" }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              title="이미지 첨부"
              style={{
                background: "transparent",
                border: "none",
                color: "#b5bac1",
                fontSize: 20,
                cursor: "pointer",
                padding: "8px 6px 8px 0",
                display: "flex",
                alignItems: "center",
              }}
            >
              📎
            </button>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendMessage()}
              placeholder={
                uploading ? "이미지 업로드 중..." : `#${channelName}에 메시지 보내기`
              }
              disabled={uploading}
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
            <div style={{ position: "relative" }}>
              <button
                onClick={() => setShowInputEmojiPicker((v) => !v)}
                title="이모지 삽입"
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#b5bac1",
                  fontSize: 18,
                  cursor: "pointer",
                  padding: "6px 6px",
                  display: "flex",
                  alignItems: "center",
                }}
              >
                🙂
              </button>
              {showInputEmojiPicker && (
                <EmojiPicker
                  align="right"
                  onPick={(emoji) => {
                    setInput((prev) => prev + emoji);
                    setShowInputEmojiPicker(false);
                  }}
                  onClose={() => setShowInputEmojiPicker(false)}
                />
              )}
            </div>
            <button
              onClick={sendMessage}
              disabled={uploading}
              style={{
                background: "transparent",
                border: "none",
                color: (input.trim() || pendingImage) && !uploading ? "#5865F2" : "#4e5058",
                fontWeight: 700,
                fontSize: 13,
                cursor: (input.trim() || pendingImage) && !uploading ? "pointer" : "default",
                padding: "6px 4px",
              }}
            >
              {uploading ? "전송 중..." : "전송"}
            </button>
          </div>
        </div>
      </div>

      {showAdmin && (
        <AdminPanel currentCode={currentCode} onClose={() => setShowAdmin(false)} />
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
  // gate -> licensePrompt -> checking -> setPassword -> chat / killed
  const [stage, setStage] = useState("gate");
  const [licenseError, setLicenseError] = useState(false);
  const [licenseErrorMsg, setLicenseErrorMsg] = useState("");
  const [currentUser, setCurrentUser] = useState(""); // 관리자가 부여한 고유 이름 (@이름)
  const [currentCode, setCurrentCode] = useState(""); // 로그인에 사용한 라이선스 코드
  const [nickname, setNickname] = useState(""); // 채팅에 표시되는 닉네임 (없으면 currentUser 그대로)
  const [isAdmin, setIsAdmin] = useState(false);

  if (!CONFIGURED) return <NotConfiguredScreen />;

  function handleUnlockAttempt() {
    setLicenseError(false);
    setLicenseErrorMsg("");
    setStage("licensePrompt");
  }

  function applyUser(match) {
    setCurrentUser(match.name);
    setCurrentCode(match.code);
    setNickname(match.nickname || "");
    setIsAdmin(Boolean(match.is_admin));
  }

  // 라이선스 코드로 로그인
  async function handleLicenseSubmit(code) {
    if (!code) return;
    setStage("checking");
    try {
      const rows = await sbSelect(
        "whitelist",
        `code=eq.${encodeURIComponent(code)}&select=name,code,is_admin,nickname,password_hash`
      );
      if (rows.length > 0) {
        const match = rows[0];
        applyUser(match);
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

  // 이름 + 비밀번호로 로그인
  async function handlePasswordSubmit(name, password) {
    if (!name || !password) {
      setLicenseError(true);
      setLicenseErrorMsg("이름과 비밀번호를 모두 입력해주세요.");
      return;
    }
    setStage("checking");
    try {
      const rows = await sbSelect(
        "whitelist",
        `name=eq.${encodeURIComponent(name)}&select=name,code,is_admin,nickname,password_hash`
      );
      if (rows.length === 0) {
        setLicenseError(true);
        setLicenseErrorMsg("이름 또는 비밀번호가 올바르지 않습니다.");
        setStage("licensePrompt");
        return;
      }
      const match = rows[0];
      if (!match.password_hash) {
        setLicenseError(true);
        setLicenseErrorMsg("아직 비밀번호가 설정되지 않았어요. 라이선스 코드로 먼저 접속해주세요.");
        setStage("licensePrompt");
        return;
      }
      const hash = await hashPassword(match.name, password);
      if (hash !== match.password_hash) {
        setLicenseError(true);
        setLicenseErrorMsg("이름 또는 비밀번호가 올바르지 않습니다.");
        setStage("licensePrompt");
        return;
      }
      applyUser(match);
      setStage("chat");
    } catch (e) {
      setLicenseError(true);
      setLicenseErrorMsg(`연결 실패: ${e.message}`);
      setStage("licensePrompt");
    }
  }

  if (stage === "killed") return <KilledScreen />;

  if (stage === "chat") {
    return (
      <ChatMain
        currentUser={currentUser}
        currentCode={currentCode}
        nickname={nickname}
        onNicknameChange={setNickname}
        isAdmin={isAdmin}
      />
    );
  }

  return (
    <>
      <FakeNotFound onUnlock={handleUnlockAttempt} />
      {(stage === "licensePrompt" || stage === "checking") && (
        <LicenseModal
          onSubmitCode={handleLicenseSubmit}
          onSubmitPassword={handlePasswordSubmit}
          error={licenseError}
          errorMsg={licenseErrorMsg}
          checking={stage === "checking"}
          onClose={() => setStage("gate")}
        />
      )}
    </>
  );
}
