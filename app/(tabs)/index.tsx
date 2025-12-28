import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from "react-native";
import * as Notifications from "expo-notifications";
import Svg, {
  Circle,
  Defs,
  G,
  Line,
  Path,
  RadialGradient,
  Stop,
  Text as SvgText,
} from "react-native-svg";

/* -------------------- NOTIFICATIONS: DISPLAY BEHAVIOR -------------------- */

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

/* -------------------- TYPES -------------------- */

type Marker = {
  id: string;
  name: string;
  hour: number;
  minute: number;
  enabled: boolean; // show/hide on clock + Next Event + sorting
  notify: boolean; // included in notifications scheduling
};

type Density = "comfortable" | "standard" | "compact";

/* -------------------- THEME -------------------- */

const ACCENT = "rgba(88, 164, 110, 1)"; // slightly deeper green
const ACCENT_DIM = "rgba(88, 164, 110, 0.78)";
const BG_BASE = "#071A2E"; // blue-tinted dark background

/* -------------------- STORAGE -------------------- */

const STORAGE_KEY = "palia_markers_v3";
const DENSITY_KEY = "palia_density_v1";
const NOTIF_SETTINGS_KEY = "palia_notif_settings_v1";

/* -------------------- DEFAULT MARKERS -------------------- */

const DEFAULT_MARKERS: Marker[] = [
  { id: "flowers_kilima_1200", name: "Flowers Bloom - Kilima", hour: 12, minute: 0, enabled: true, notify: true },
  { id: "hotpot_underground_1800", name: "Play Hotpot - Underground", hour: 18, minute: 0, enabled: true, notify: true },
  { id: "decor_reset_underground_1800", name: "Exclusive Decor Reset - Underground", hour: 18, minute: 0, enabled: true, notify: true },
  { id: "shipping_bin_home_1800", name: "Shipping Bin - Home Plot", hour: 18, minute: 0, enabled: true, notify: true },
  { id: "maji_market_1800", name: "Maji Market Opens", hour: 18, minute: 0, enabled: true, notify: true },
  { id: "piksii_elderwood_2200", name: "Piksii Blossom Bounce - Elderwood", hour: 22, minute: 0, enabled: true, notify: true },
  { id: "gift_collection_home_0000", name: "Gift Collection - Home Plot", hour: 0, minute: 0, enabled: true, notify: true },
  { id: "grove_bahari_0000", name: "Flow Tree Grove - Bahari Bay", hour: 0, minute: 0, enabled: true, notify: true },
  { id: "shipping_bin_home_0600", name: "Shipping Bin - Home Plot", hour: 6, minute: 0, enabled: true, notify: true },
  { id: "farm_reset_home_0600", name: "Farm Reset - Home Plot", hour: 6, minute: 0, enabled: true, notify: true },
];

/* -------------------- TIME HELPERS -------------------- */

// Palia day = 1 real hour
function getPaliaMinutesNow() {
  const now = new Date();
  const secondsIntoHour =
    now.getMinutes() * 60 + now.getSeconds() + now.getMilliseconds() / 1000;
  return (secondsIntoHour / 3600) * 1440; // 0..1440
}

function getPaliaTime() {
  const paliaMinutesTotal = getPaliaMinutesNow();
  const hour = Math.floor(paliaMinutesTotal / 60) % 24;
  const minute = Math.floor(paliaMinutesTotal % 60);
  const formatted = `${pad2(hour)}:${pad2(minute)}`;
  return { hour, minute, formatted };
}

function getSecondsUntilNextPaliaTime(targetHour: number, targetMinute: number) {
  const currentPaliaMinutes = getPaliaMinutesNow();
  let targetPaliaMinutes = targetHour * 60 + targetMinute;

  if (targetPaliaMinutes <= currentPaliaMinutes) targetPaliaMinutes += 1440;

  const paliaMinutesRemaining = targetPaliaMinutes - currentPaliaMinutes;
  const realSecondsRemaining = (paliaMinutesRemaining / 1440) * 3600;

  return Math.max(0, Math.ceil(realSecondsRemaining));
}

function formatCountdown(totalSeconds: number) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  return `${pad2(m)}:${pad2(s)}`;
}

function pad2(n: number) {
  return n.toString().padStart(2, "0");
}

function makeId() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function clampTimeInputs(hourStr: string, minuteStr: string) {
  let h = parseInt(hourStr, 10);
  let m = parseInt(minuteStr, 10);
  if (Number.isNaN(h)) h = 0;
  if (Number.isNaN(m)) m = 0;
  h = Math.max(0, Math.min(23, h));
  m = Math.max(0, Math.min(59, m));
  return { h, m };
}

/* -------------------- NOTIFICATION HELPERS (LOCAL ONLY) -------------------- */

async function ensureNotificationPermissions() {
  if (Platform.OS === "web") return false;

  const existing = await Notifications.getPermissionsAsync();
  if (existing.status === "granted") return true;

  const req = await Notifications.requestPermissionsAsync();
  return req.status === "granted";
}

async function ensureAndroidChannel() {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync("palia", {
    name: "Palia Events",
    importance: Notifications.AndroidImportance.DEFAULT,
  });
}

async function scheduleTestNotificationIn5s() {
  if (Platform.OS === "web") return false;

  const permitted = await ensureNotificationPermissions();
  if (!permitted) return false;

  await ensureAndroidChannel();

  await Notifications.scheduleNotificationAsync({
    content: {
      title: "Palia Time Tracker",
      body: "Test notification (5s)",
      sound: null,
      channelId: "palia",
    },
    trigger: { seconds: 5 },
  });

  return true;
}

/**
 * Local notifications scheduler.
 * - Uses seconds triggers (reliable in Expo Go)
 * - Avoids push token APIs completely
 * - If you are already within the reminder window, it fires ASAP instead of skipping.
 */
async function rescheduleAllNotifications(args: {
  markers: Marker[];
  notificationsEnabled: boolean;
  reminderMinutes: number; // real minutes
}) {
  if (Platform.OS === "web") return { scheduled: 0 };

  const { markers, notificationsEnabled, reminderMinutes } = args;

  await Notifications.cancelAllScheduledNotificationsAsync();

  if (!notificationsEnabled) return { scheduled: 0 };

  const permitted = await ensureNotificationPermissions();
  if (!permitted) return { scheduled: 0 };

  await ensureAndroidChannel();

  const notifiable = markers.filter((m) => m.enabled && m.notify);
  if (notifiable.length === 0) return { scheduled: 0 };

  const MAX_TOTAL = 60;
  const perMarker = Math.max(1, Math.floor(MAX_TOTAL / notifiable.length));
  const occurrences = Math.min(5, perMarker);

  const leadSeconds = Math.max(0, Math.floor(reminderMinutes * 60));

  let scheduled = 0;

  for (const m of notifiable) {
    const base = getSecondsUntilNextPaliaTime(m.hour, m.minute); // seconds to next occurrence

    for (let i = 0; i < occurrences; i++) {
      const targetIn = base + i * 3600; // every real hour repeats
      let fireIn = targetIn - leadSeconds;

      // If we're already inside reminder window for the next occurrence, fire ASAP.
      if (i === 0 && fireIn < 1) fireIn = 1;

      if (fireIn < 1) continue;

      await Notifications.scheduleNotificationAsync({
        content: {
          title: `Palia: ${m.name}`,
          body:
            reminderMinutes > 0
              ? `Reminder: ${pad2(m.hour)}:${pad2(m.minute)}`
              : `Starts now: ${pad2(m.hour)}:${pad2(m.minute)}`,
          sound: null,
          channelId: "palia",
          data: { markerId: m.id, paliaTime: `${pad2(m.hour)}:${pad2(m.minute)}` },
        },
        trigger: { seconds: fireIn },
      });

      scheduled++;
    }
  }

  return { scheduled };
}

/* -------------------- BACKGROUND SPARKLES -------------------- */

const BackgroundSparkles = React.memo(function BackgroundSparkles() {
  const { width, height } = useWindowDimensions();

  const rand01 = (seed: number) => {
    let t = seed + 0x6d2b79f5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const sparklePath = (x: number, y: number, r: number) => {
    const short = r * 0.45;
    let d = "";
    for (let k = 0; k < 8; k++) {
      const deg = -90 + k * 45;
      const rad = (deg * Math.PI) / 180;
      const rr = k % 2 === 0 ? r : short;
      const px = x + Math.cos(rad) * rr;
      const py = y + Math.sin(rad) * rr;
      d += k === 0 ? `M ${px} ${py}` : ` L ${px} ${py}`;
    }
    return d + " Z";
  };

  const sparkles = useMemo(() => {
    const BASE_AREA = 390 * 844;
    const baseCount = 170 * 2; // doubled
    const COUNT = Math.max(320, Math.round((width * height / BASE_AREA) * baseCount));

    return Array.from({ length: COUNT }, (_, i) => {
      const x = rand01(i + 10) * width;
      const y = rand01(i + 200) * height;

      let size = 0.9 + rand01(i + 400) * 2.8;
      if (i % 13 === 0) size *= 1.7;
      if (i % 31 === 0) size *= 2.2;

      // more opaque
      let op = (0.02 + rand01(i + 700) * 0.07) * 1.95;
      if (i % 11 === 0) op += 0.03;
      op = Math.min(0.26, op);

      return { x, y, size, op };
    });
  }, [width, height]);

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <Path d={`M 0 0 H ${width} V ${height} H 0 Z`} fill={BG_BASE} />
        <Defs>
          <RadialGradient id="bgVignette" cx="50%" cy="40%" r="80%">
            <Stop offset="0%" stopColor="rgba(0,0,0,0.00)" />
            <Stop offset="60%" stopColor="rgba(0,0,0,0.18)" />
            <Stop offset="100%" stopColor="rgba(0,0,0,0.62)" />
          </RadialGradient>
        </Defs>

        <Circle
          cx={width / 2}
          cy={height * 0.42}
          r={Math.max(width, height)}
          fill="url(#bgVignette)"
        />

        {sparkles.map((sp, idx) => (
          <Path
            key={`bgsp-${idx}`}
            d={sparklePath(sp.x, sp.y, sp.size)}
            fill="rgba(245,250,255,1)"
            opacity={sp.op}
          />
        ))}
      </Svg>
    </View>
  );
});

/* -------------------- REAL TIME CARD -------------------- */

function RealTimeCard() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const hh = pad2(now.getHours());
  const mm = pad2(now.getMinutes());

  return (
    <View style={{ alignItems: "center" }}>
      <Text style={styles.realLabel}>REAL TIME</Text>
      <View style={styles.realBox}>
        <Text style={styles.realText}>{`${hh}:${mm}`}</Text>
      </View>
    </View>
  );
}

/* -------------------- CLOCK COMPONENT -------------------- */

const CLOCK_DIAM = 288;
const CANVAS_SIZE = 360;

function PaliaClockFace({
  paliaHour,
  paliaMinute,
  markers,
  nextTimeKey,
  onMarkerPress,
}: {
  paliaHour: number;
  paliaMinute: number;
  markers: Marker[];
  nextTimeKey: string | null;
  onMarkerPress?: (marker: Marker) => void;
}) {
  const SIZE = CANVAS_SIZE;
  const CX = SIZE / 2;
  const CY = SIZE / 2;

  const SCALE = CLOCK_DIAM / 320;
  const S = (n: number) => n * SCALE;

  const BORDER_R = S(154);
  const R_OUT_BASE = S(142);
  const R_IN_BASE = S(108);

  // +10% thicker coloured ring
  const RING_THICKNESS = R_OUT_BASE - R_IN_BASE;
  const RING_THICKNESS_PLUS = RING_THICKNESS * 1.1;
  const THICK_DELTA = (RING_THICKNESS_PLUS - RING_THICKNESS) / 2;
  const R_OUT = R_OUT_BASE + THICK_DELTA;
  const R_IN = R_IN_BASE - THICK_DELTA;

  const EDGE_R = SIZE / 2 - 2;

  // saved marker arrows (outside)
  const MARKER_ARROW_TIP_R = BORDER_R;
  const MARKER_ARROW_BASE_R = Math.min(EDGE_R, BORDER_R + S(15));
  const MARKER_ARROW_SPREAD_DEG = 1.25 * 1.5;

  const FADE_MINS = 22;

  const minutesToAngle = (mins: number) => {
    const shifted = (mins - 12 * 60 + 1440) % 1440;
    return (shifted / 1440) * 360;
  };

  function polar(angleDeg: number, radius: number) {
    const rad = ((angleDeg - 90) * Math.PI) / 180;
    return { x: CX + Math.cos(rad) * radius, y: CY + Math.sin(rad) * radius };
  }

  const donutSegmentPath = (startAngle: number, endAngle: number) => {
    const sweep = endAngle - startAngle;
    const largeArc = sweep > 180 ? 1 : 0;

    const p1 = polar(startAngle, R_OUT);
    const p2 = polar(endAngle, R_OUT);
    const p3 = polar(endAngle, R_IN);
    const p4 = polar(startAngle, R_IN);

    return `
      M ${p1.x} ${p1.y}
      A ${R_OUT} ${R_OUT} 0 ${largeArc} 1 ${p2.x} ${p2.y}
      L ${p3.x} ${p3.y}
      A ${R_IN} ${R_IN} 0 ${largeArc} 0 ${p4.x} ${p4.y}
      Z
    `;
  };

  const pieSegmentPath = (startAngle: number, endAngle: number, radius: number) => {
    const sweep = endAngle - startAngle;
    const largeArc = sweep > 180 ? 1 : 0;

    const p1 = polar(startAngle, radius);
    const p2 = polar(endAngle, radius);

    return `
      M ${CX} ${CY}
      L ${p1.x} ${p1.y}
      A ${radius} ${radius} 0 ${largeArc} 1 ${p2.x} ${p2.y}
      Z
    `;
  };

  const markerArrowPath = (angleDeg: number) => {
    const tip = polar(angleDeg, MARKER_ARROW_TIP_R);
    const left = polar(angleDeg - MARKER_ARROW_SPREAD_DEG, MARKER_ARROW_BASE_R);
    const right = polar(angleDeg + MARKER_ARROW_SPREAD_DEG, MARKER_ARROW_BASE_R);
    return `M ${tip.x} ${tip.y} L ${left.x} ${left.y} L ${right.x} ${right.y} Z`;
  };

  // inner sparkles
  const rand01 = (seed: number) => {
    let t = seed + 0x6d2b79f5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const sparklePath = (x: number, y: number, r: number) => {
    const short = r * 0.45;
    let d = "";
    for (let k = 0; k < 8; k++) {
      const deg = -90 + k * 45;
      const rad = (deg * Math.PI) / 180;
      const rr = k % 2 === 0 ? r : short;
      const px = x + Math.cos(rad) * rr;
      const py = y + Math.sin(rad) * rr;
      d += k === 0 ? `M ${px} ${py}` : ` L ${px} ${py}`;
    }
    return d + " Z";
  };

  const sparkles = useMemo(() => {
    const SPARKLE_COUNT = 48;
    const SPARKLE_R_MIN = R_IN + S(8);
    const SPARKLE_R_MAX = BORDER_R - S(8);

    return Array.from({ length: SPARKLE_COUNT }, (_, i) => {
      const a = rand01(i + 10) * 360;
      const rr = SPARKLE_R_MIN + rand01(i + 200) * (SPARKLE_R_MAX - SPARKLE_R_MIN);
      const p = polar(a, rr);

      let size = (S(1.0) + rand01(i + 400) * S(1.2)) * 1.05;
      if (i % 11 === 0) size *= 1.6;

      // +75% visibility overall (subtle)
      let op = (0.05 + rand01(i + 700) * 0.10) * 1.75;
      if (i % 11 === 0) op += 0.04;

      return { x: p.x, y: p.y, size, op };
    });
  }, []);

  const COL = {
    morning: "rgba(242, 214, 118, 1)",
    day: "rgba(108, 189, 255, 1)",
    evening: "rgba(255, 148, 192, 1)",
    night: "rgba(108, 85, 168, 1)",
  };

  const segments = [
    { start: 0, end: 3 * 60, color: COL.night, opacity: 0.58 },
    { start: 3 * 60 - FADE_MINS, end: 3 * 60, color: COL.morning, opacity: 0.20 },

    { start: 3 * 60, end: 6 * 60, color: COL.morning, opacity: 0.58 },
    { start: 6 * 60 - FADE_MINS, end: 6 * 60, color: COL.day, opacity: 0.20 },

    { start: 6 * 60, end: 18 * 60, color: COL.day, opacity: 0.58 },
    { start: 18 * 60 - FADE_MINS, end: 18 * 60, color: COL.evening, opacity: 0.20 },

    { start: 18 * 60, end: 21 * 60, color: COL.evening, opacity: 0.58 },
    { start: 21 * 60 - FADE_MINS, end: 21 * 60, color: COL.night, opacity: 0.20 },

    { start: 21 * 60, end: 24 * 60, color: COL.night, opacity: 0.58 },
  ];

  // time hand spans full ring with rounded caps
  const totalMinutes = paliaHour * 60 + paliaMinute;
  const handAngle = minutesToAngle(totalMinutes);
  const HAND_W = S(4);
  const CAP_PAD = HAND_W / 2;
  const handP1 = polar(handAngle, R_IN + CAP_PAD);
  const handP2 = polar(handAngle, R_OUT - CAP_PAD);

  const markerArrows = markers.map((m) => {
    const mins = m.hour * 60 + m.minute;
    const a = minutesToAngle(mins);
    const hitR = Math.min(EDGE_R - 6, BORDER_R + S(10));
    const hit = polar(a, hitR);
    return { ...m, angle: a, hitX: hit.x, hitY: hit.y };
  });

  const labels = Array.from({ length: 8 }, (_, i) => i * 3);
  const labelRadius = S(122);

  // Sun/Moon in black void (user saved)
  const ICON_R = S(78);
  const sunPos = polar(minutesToAngle(12 * 60), ICON_R);
  const moonPos = polar(minutesToAngle(0), ICON_R);

  const SUN_R = S(13);
  const SUN_GLOW_R = S(20);

  const MOON_BACK_R = S(20);
  const MOON_LIGHT_R = S(12);
  const MOON_CUT_R = S(11);

  // center digital
  const DISPLAY_W = S(124);
  const DISPLAY_H = S(56);
  const DISPLAY_RX = S(18);
  const displayX = CX - DISPLAY_W / 2;
  const displayY = CY - DISPLAY_H / 2;

  const INNER_TINT_R = R_IN - S(4);
  const formattedPaliaTime = `${pad2(paliaHour)}:${pad2(paliaMinute)}`;

  return (
    <View style={clockStyles.wrap}>
      <View style={clockStyles.canvas}>
        <Svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
          <Defs>
            {/* dulled ringGlow gradient (saved) */}
            <RadialGradient id="ringGlow" cx="50%" cy="35%" r="65%">
              <Stop offset="0%" stopColor="rgba(255,255,255,0.06)" />
              <Stop offset="55%" stopColor="rgba(255,255,255,0.02)" />
              <Stop offset="100%" stopColor="rgba(0,0,0,0.22)" />
            </RadialGradient>

            <RadialGradient id="innerShade" cx="50%" cy="55%" r="65%">
              <Stop offset="0%" stopColor="rgba(0,0,0,0.00)" />
              <Stop offset="70%" stopColor="rgba(0,0,0,0.00)" />
              <Stop offset="100%" stopColor="rgba(0,0,0,0.25)" />
            </RadialGradient>

            <RadialGradient id="voidShade" cx="50%" cy="50%" r="60%">
              <Stop offset="0%" stopColor="rgba(0,0,0,0.00)" />
              <Stop offset="70%" stopColor="rgba(0,0,0,0.00)" />
              <Stop offset="100%" stopColor="rgba(0,0,0,0.35)" />
            </RadialGradient>
          </Defs>

          {/* outer border */}
          <Circle
            cx={CX}
            cy={CY}
            r={BORDER_R}
            stroke="rgba(255,255,255,0.10)"
            strokeWidth={S(2)}
            fill="rgba(255,255,255,0.012)"
          />

          {/* ring segments */}
          {segments.map((s, i) => {
            const startA = minutesToAngle(s.start);
            const endA = minutesToAngle(s.end);
            return (
              <Path
                key={`seg-${i}`}
                d={donutSegmentPath(startA, endA)}
                fill={s.color}
                opacity={s.opacity}
              />
            );
          })}

          {/* dulled glow overlay opacity 0.30 (saved) */}
          <Circle cx={CX} cy={CY} r={R_OUT} fill="url(#ringGlow)" opacity={0.30} />

          {/* inner void */}
          <Circle cx={CX} cy={CY} r={R_IN - S(1)} fill="rgba(14,26,20,0.58)" />
          <Circle cx={CX} cy={CY} r={R_IN + S(3)} fill="url(#innerShade)" opacity={0.45} />
          <Circle cx={CX} cy={CY} r={R_IN - S(2)} fill="url(#voidShade)" opacity={0.45} />

          {/* inner tinted wedges */}
          {segments.map((s, i) => {
            const startA = minutesToAngle(s.start);
            const endA = minutesToAngle(s.end);
            const op = Math.min(0.35, Math.max(0.07, s.opacity * 0.28));
            return (
              <Path
                key={`innerTint-${i}`}
                d={pieSegmentPath(startA, endA, INNER_TINT_R)}
                fill={s.color}
                opacity={op}
              />
            );
          })}

          {/* sparkles */}
          {sparkles.map((sp, idx) => (
            <Path
              key={`spk-${idx}`}
              d={sparklePath(sp.x, sp.y, sp.size)}
              fill="rgba(255,255,255,1)"
              opacity={sp.op}
            />
          ))}

          {/* hour ticks */}
          {Array.from({ length: 24 }, (_, h) => {
            const a = minutesToAngle(h * 60);
            const p1 = polar(a, S(134));
            const p2 = polar(a, S(140));
            const isMajor = h % 3 === 0;
            return (
              <Line
                key={`tick-${h}`}
                x1={p1.x}
                y1={p1.y}
                x2={p2.x}
                y2={p2.y}
                stroke={isMajor ? "rgba(255,255,255,0.45)" : "rgba(255,255,255,0.22)"}
                strokeWidth={isMajor ? S(3) : S(2)}
                strokeLinecap="round"
              />
            );
          })}

          {/* 3-hour labels */}
          {labels.map((h) => {
            const a = minutesToAngle(h * 60);
            const p = polar(a, labelRadius);
            return (
              <SvgText
                key={`lab-${h}`}
                x={p.x}
                y={p.y}
                fill="rgba(255,255,255,0.72)"
                fontSize={S(12)}
                fontWeight="800"
                textAnchor="middle"
                alignmentBaseline="middle"
                letterSpacing={S(1)}
              >
                {pad2(h)}
              </SvgText>
            );
          })}

          {/* saved marker arrows */}
          {markerArrows.map((m) => {
            const key = `${pad2(m.hour)}:${pad2(m.minute)}`;
            const isNextTime = !!nextTimeKey && key === nextTimeKey;

            return (
              <G key={`mkarrow-${m.id}`} onPress={() => onMarkerPress?.(m)}>
                <Circle cx={m.hitX} cy={m.hitY} r={S(18)} fill="rgba(0,0,0,0)" />
                <Path
                  d={markerArrowPath(m.angle)}
                  fill={isNextTime ? ACCENT : "rgba(255,255,255,0.60)"}
                  opacity={isNextTime ? 0.95 : 0.60}
                />
              </G>
            );
          })}

          {/* current time hand */}
          <Line
            x1={handP1.x}
            y1={handP1.y}
            x2={handP2.x}
            y2={handP2.y}
            stroke="rgba(245,250,255,0.92)"
            strokeWidth={HAND_W}
            strokeLinecap="round"
          />

          {/* sun */}
          <Circle cx={sunPos.x} cy={sunPos.y} r={SUN_R} fill="rgba(242,214,118,1)" opacity={0.95} />
          <Circle cx={sunPos.x} cy={sunPos.y} r={SUN_GLOW_R} fill="rgba(242,214,118,0.16)" />

          {/* moon (UPDATED — exact snippet you saved) */}
          <Circle cx={moonPos.x} cy={moonPos.y} r={MOON_BACK_R} fill="rgba(14,21,26,1)" />
          <Circle cx={moonPos.x} cy={moonPos.y} r={MOON_LIGHT_R} fill="rgba(220,240,255,0.75)" />
          <Circle cx={moonPos.x + S(5)} cy={moonPos.y - S(2)} r={MOON_CUT_R} fill="rgba(14, 21, 26, 1)" />

          {/* centre digital (saved settings) */}
          <G>
            <Path
              d={`
                M ${displayX + DISPLAY_RX} ${displayY}
                H ${displayX + DISPLAY_W - DISPLAY_RX}
                Q ${displayX + DISPLAY_W} ${displayY} ${displayX + DISPLAY_W} ${displayY + DISPLAY_RX}
                V ${displayY + DISPLAY_H - DISPLAY_RX}
                Q ${displayX + DISPLAY_W} ${displayY + DISPLAY_H} ${displayX + DISPLAY_W - DISPLAY_RX} ${displayY + DISPLAY_H}
                H ${displayX + DISPLAY_RX}
                Q ${displayX} ${displayY + DISPLAY_H} ${displayX} ${displayY + DISPLAY_H - DISPLAY_RX}
                V ${displayY + DISPLAY_RX}
                Q ${displayX} ${displayY} ${displayX + DISPLAY_RX} ${displayY}
                Z
              `}
              fill="rgba(14,26,20,0.92)"
              stroke="rgba(255,255,255,0.12)"
              strokeWidth={S(2)}
            />
            <SvgText
              x={CX}
              y={CY + S(1)}
              fill="rgba(245,250,255,0.92)"
              fontSize={S(20)}
              fontWeight="800"
              textAnchor="middle"
              alignmentBaseline="middle"
              letterSpacing={S(2)}
            >
              {formattedPaliaTime}
            </SvgText>
          </G>
        </Svg>
      </View>
    </View>
  );
}

const clockStyles = StyleSheet.create({
  wrap: { width: "100%", alignItems: "center", justifyContent: "flex-start", paddingTop: 0, paddingBottom: 0 },
  canvas: { width: CANVAS_SIZE, height: CANVAS_SIZE, marginTop: -18, marginBottom: -10 },
});

/* -------------------- HOME SCREEN -------------------- */

export default function HomeScreen() {
  const [paliaTime, setPaliaTime] = useState(getPaliaTime());

  const [markers, setMarkers] = useState<Marker[]>(DEFAULT_MARKERS);
  const markersRef = useRef<Marker[]>(DEFAULT_MARKERS);

  const [density, setDensity] = useState<Density>("standard");

  // Notifications settings
  const REMINDER_OPTIONS = [0, 1, 2, 5];
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [reminderIndex, setReminderIndex] = useState(0);

  const [scheduledCount, setScheduledCount] = useState(0);
  const [notifStatus, setNotifStatus] = useState("");

  // Add/edit form
  const [newName, setNewName] = useState("My marker");
  const [newHour, setNewHour] = useState("06");
  const [newMinute, setNewMinute] = useState("00");
  const [editingId, setEditingId] = useState<string | null>(null);

  const [countdowns, setCountdowns] = useState<Record<string, number>>({});

  useEffect(() => {
    markersRef.current = markers;
  }, [markers]);

  // Load markers (+ migration)
  useEffect(() => {
    (async () => {
      try {
        const saved = await AsyncStorage.getItem(STORAGE_KEY);
        if (saved) {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed) && parsed.length > 0) {
            const migrated: Marker[] = parsed.map((m: any) => ({
              id: String(m.id ?? makeId()),
              name: String(m.name ?? "Marker"),
              hour: Number.isFinite(m.hour) ? m.hour : 0,
              minute: Number.isFinite(m.minute) ? m.minute : 0,
              enabled: typeof m.enabled === "boolean" ? m.enabled : true,
              notify: typeof m.notify === "boolean" ? m.notify : true,
            }));
            setMarkers(migrated);
            return;
          }
        }
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_MARKERS));
      } catch {}
    })();
  }, []);

  // Save markers
  useEffect(() => {
    (async () => {
      try {
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(markers));
      } catch {}
    })();
  }, [markers]);

  // Load density
  useEffect(() => {
    (async () => {
      try {
        const saved = await AsyncStorage.getItem(DENSITY_KEY);
        if (saved === "comfortable" || saved === "standard" || saved === "compact") setDensity(saved);
      } catch {}
    })();
  }, []);

  // Save density
  useEffect(() => {
    (async () => {
      try {
        await AsyncStorage.setItem(DENSITY_KEY, density);
      } catch {}
    })();
  }, [density]);

  // Load notification settings
  useEffect(() => {
    (async () => {
      try {
        const saved = await AsyncStorage.getItem(NOTIF_SETTINGS_KEY);
        if (saved) {
          const s = JSON.parse(saved);
          if (typeof s.notificationsEnabled === "boolean") setNotificationsEnabled(s.notificationsEnabled);
          if (typeof s.reminderIndex === "number") {
            setReminderIndex(Math.max(0, Math.min(REMINDER_OPTIONS.length - 1, s.reminderIndex)));
          }
        }
      } catch {}
    })();
  }, []);

  // Save notification settings
  useEffect(() => {
    (async () => {
      try {
        await AsyncStorage.setItem(
          NOTIF_SETTINGS_KEY,
          JSON.stringify({ notificationsEnabled, reminderIndex })
        );
      } catch {}
    })();
  }, [notificationsEnabled, reminderIndex]);

  // Init countdowns
  useEffect(() => {
    const next: Record<string, number> = {};
    for (const m of markers) next[m.id] = getSecondsUntilNextPaliaTime(m.hour, m.minute);
    setCountdowns(next);
  }, [markers]);

  // Single tick (stable real seconds)
  useEffect(() => {
    const id = setInterval(() => {
      setPaliaTime(getPaliaTime());

      setCountdowns((prev) => {
        const next = { ...prev };
        const ms = markersRef.current;

        for (const m of ms) {
          const cur = next[m.id];
          if (typeof cur !== "number" || cur <= 1) next[m.id] = getSecondsUntilNextPaliaTime(m.hour, m.minute);
          else next[m.id] = cur - 1;
        }

        for (const key of Object.keys(next)) {
          if (!ms.some((m) => m.id === key)) delete next[key];
        }

        return next;
      });
    }, 1000);

    return () => clearInterval(id);
  }, []);

  // Density: fixed compact fonts, padding steps only
  const densityVars = useMemo(() => {
    const fixed = { nameSize: 14, metaSize: 11, countdownSize: 14 };
    if (density === "compact") return { rowPadV: 8, ...fixed };
    if (density === "standard") return { rowPadV: 11, ...fixed };
    return { rowPadV: 14, ...fixed };
  }, [density]);

  // Sort by soonest next (live)
  const sortedMarkers = useMemo(() => {
    return [...markers].sort((a, b) => (countdowns[a.id] ?? 9e15) - (countdowns[b.id] ?? 9e15));
  }, [markers, countdowns]);

  const enabledMarkers = useMemo(() => sortedMarkers.filter((m) => m.enabled), [sortedMarkers]);

  const nextTimeKey = useMemo(() => {
    if (!enabledMarkers.length) return null;
    const first = enabledMarkers[0];
    return `${pad2(first.hour)}:${pad2(first.minute)}`;
  }, [enabledMarkers]);

  const nextItems = useMemo(() => {
    if (!nextTimeKey) return [];
    return enabledMarkers
      .filter((m) => `${pad2(m.hour)}:${pad2(m.minute)}` === nextTimeKey)
      .map((m) => m.name);
  }, [enabledMarkers, nextTimeKey]);

  const nextCountdown = useMemo(() => {
    if (!enabledMarkers.length) return 0;
    return countdowns[enabledMarkers[0].id] ?? 0;
  }, [enabledMarkers, countdowns]);

  const reminderMinutes = REMINDER_OPTIONS[reminderIndex] ?? 0;

  // Reschedule local notifications when markers/settings change (not every second)
  useEffect(() => {
    (async () => {
      try {
        if (Platform.OS === "web") return;

        const { scheduled } = await rescheduleAllNotifications({
          markers,
          notificationsEnabled,
          reminderMinutes,
        });

        const all = await Notifications.getAllScheduledNotificationsAsync();
        setScheduledCount(all.length);
        if (notificationsEnabled) setNotifStatus(`Scheduled ${all.length} alerts`);
      } catch {
        // If you still see the Expo Go push warning, it means something else is calling getExpoPushTokenAsync().
        setNotifStatus("Scheduling failed (check logs)");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markers, notificationsEnabled, reminderMinutes]);

  function resetForm() {
    setEditingId(null);
    setNewName("My marker");
    setNewHour("06");
    setNewMinute("00");
  }

  function startEdit(marker: Marker) {
    setEditingId(marker.id);
    setNewName(marker.name);
    setNewHour(pad2(marker.hour));
    setNewMinute(pad2(marker.minute));
  }

  function toggleEnabled(id: string) {
    setMarkers((prev) => prev.map((m) => (m.id === id ? { ...m, enabled: !m.enabled } : m)));
  }

  function toggleNotify(id: string) {
    setMarkers((prev) => prev.map((m) => (m.id === id ? { ...m, notify: !m.notify } : m)));
  }

  function addOrSave() {
    const name = newName.trim() || "Marker";
    const { h, m } = clampTimeInputs(newHour, newMinute);

    if (editingId) {
      setMarkers((prev) =>
        prev.map((mk) => (mk.id === editingId ? { ...mk, name, hour: h, minute: m } : mk))
      );
      resetForm();
      return;
    }

    setMarkers((prev) => [{ id: makeId(), name, hour: h, minute: m, enabled: true, notify: true }, ...prev]);
  }

  function deleteMarker(id: string) {
    if (editingId === id) resetForm();
    setMarkers((prev) => prev.filter((m) => m.id !== id));
  }

  async function toggleNotificationsMaster() {
    if (Platform.OS === "web") return;

    if (!notificationsEnabled) {
      const ok = await ensureNotificationPermissions();
      if (!ok) {
        setNotifStatus("Permission not granted");
        return;
      }
      await ensureAndroidChannel();
      setNotificationsEnabled(true);
      setNotifStatus("Notifications enabled");
    } else {
      setNotificationsEnabled(false);
      setNotifStatus("Notifications off");
      try {
        await Notifications.cancelAllScheduledNotificationsAsync();
        setScheduledCount(0);
      } catch {}
    }
  }

  async function manualReschedule() {
    if (Platform.OS === "web") return;

    try {
      const { scheduled } = await rescheduleAllNotifications({
        markers,
        notificationsEnabled,
        reminderMinutes,
      });

      const all = await Notifications.getAllScheduledNotificationsAsync();
      setScheduledCount(all.length);
      setNotifStatus(`Scheduled ${all.length} alerts`);
    } catch {
      setNotifStatus("Refresh failed (check logs)");
    }
  }

  async function testNotification() {
    if (Platform.OS === "web") return;

    try {
      const ok = await scheduleTestNotificationIn5s();
      if (!ok) {
        setNotifStatus("Permission not granted");
        return;
      }
      const all = await Notifications.getAllScheduledNotificationsAsync();
      setScheduledCount(all.length);
      setNotifStatus("Test scheduled (5s)");
    } catch {
      setNotifStatus("Test failed (check logs)");
    }
  }

  return (
    <View style={styles.root}>
      <BackgroundSparkles />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {/* PALIA TIME CARD */}
        <View style={[styles.glassCard, styles.clockCard]}>
          <Text style={styles.clockLabel}>PALIA TIME</Text>

          <PaliaClockFace
            paliaHour={paliaTime.hour}
            paliaMinute={paliaTime.minute}
            markers={markers.filter((m) => m.enabled)}
            nextTimeKey={nextTimeKey}
            onMarkerPress={startEdit}
          />

          {/* NEXT EVENT LIST */}
          {nextTimeKey && nextItems.length > 0 ? (
            <View style={styles.nextCard}>
              <Text style={styles.nextTitle}>
                Next Event ({nextTimeKey}) • {formatCountdown(nextCountdown)}
              </Text>
              <View style={{ gap: 6 }}>
                {nextItems.map((name, idx) => (
                  <Text key={`${nextTimeKey}-${idx}`} style={styles.nextItem}>
                    {" - "}
                    {name}
                  </Text>
                ))}
              </View>
            </View>
          ) : (
            <View style={styles.nextCard}>
              <Text style={styles.nextTitle}>Next Event</Text>
              <Text style={styles.nextItem}>{" - "}No enabled events</Text>
            </View>
          )}

          {editingId ? (
            <View style={styles.editingPill}>
              <Text style={styles.editingPillText}>Editing marker</Text>
            </View>
          ) : null}
        </View>

        {/* REAL TIME CARD */}
        <View style={[styles.glassCard, styles.realCard]}>
          <RealTimeCard />
        </View>

        {/* ADD / EDIT CARD */}
        <View style={[styles.glassCard, styles.card]}>
          <Text style={styles.cardTitle}>{editingId ? "Edit marker" : "Add marker"}</Text>

          <TextInput
            value={newName}
            onChangeText={setNewName}
            placeholder="Name (e.g. Grove)"
            placeholderTextColor="rgba(255,255,255,0.55)"
            style={styles.input}
          />

          <View style={styles.timeRow}>
            <View style={styles.timeBox}>
              <Text style={styles.timeBoxLabel}>HH</Text>
              <TextInput
                value={newHour}
                onChangeText={setNewHour}
                keyboardType="number-pad"
                maxLength={2}
                style={styles.timeInput}
                placeholder="00"
                placeholderTextColor="rgba(255,255,255,0.40)"
              />
            </View>

            <Text style={styles.colon}>:</Text>

            <View style={styles.timeBox}>
              <Text style={styles.timeBoxLabel}>MM</Text>
              <TextInput
                value={newMinute}
                onChangeText={setNewMinute}
                keyboardType="number-pad"
                maxLength={2}
                style={styles.timeInput}
                placeholder="00"
                placeholderTextColor="rgba(255,255,255,0.40)"
              />
            </View>

            <TouchableOpacity style={styles.primaryBtn} onPress={addOrSave} activeOpacity={0.85}>
              <Text style={styles.primaryBtnText}>{editingId ? "Save" : "Add"}</Text>
            </TouchableOpacity>

            {editingId ? (
              <TouchableOpacity style={styles.ghostBtn} onPress={resetForm} activeOpacity={0.85}>
                <Text style={styles.ghostBtnText}>Cancel</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>

        {/* MARKERS CARD */}
        <View style={[styles.glassCard, styles.card]}>
          <View style={styles.cardHeaderRow}>
            <View style={{ flexDirection: "row", alignItems: "baseline" }}>
              <Text style={styles.cardTitle}>Markers</Text>
              <Text style={styles.cardSubtitle}>  {markers.length}</Text>
            </View>

            <View style={styles.segment}>
              {[
                { key: "comfortable", label: "C" },
                { key: "standard", label: "S" },
                { key: "compact", label: "X" },
              ].map((opt) => {
                const active = density === opt.key;
                return (
                  <TouchableOpacity
                    key={opt.key}
                    onPress={() => setDensity(opt.key as Density)}
                    style={[styles.segmentBtn, active && styles.segmentBtnActive]}
                    activeOpacity={0.85}
                  >
                    <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          <View style={{ gap: 10 }}>
            {sortedMarkers.map((m) => {
              const disabled = !m.enabled;
              const bellOn = m.notify;

              return (
                <View
                  key={m.id}
                  style={[
                    styles.markerRow,
                    { paddingVertical: densityVars.rowPadV },
                    disabled && styles.markerRowDisabled,
                  ]}
                >
                  {/* Enable tickbox (far left) */}
                  <TouchableOpacity
                    onPress={() => toggleEnabled(m.id)}
                    style={[styles.checkBox, m.enabled && styles.checkBoxOn]}
                    activeOpacity={0.85}
                  >
                    {m.enabled ? <Text style={styles.checkMark}>✓</Text> : null}
                  </TouchableOpacity>

                  {/* Notify bell */}
                  <TouchableOpacity
                    onPress={() => toggleNotify(m.id)}
                    style={[styles.bellBtn, (!bellOn || disabled) && { opacity: 0.55 }]}
                    activeOpacity={0.85}
                  >
                    <Text style={styles.bellText}>{bellOn ? "🔔" : "🔕"}</Text>
                  </TouchableOpacity>

                  {/* Edit */}
                  <Pressable
                    style={{ flex: 1 }}
                    onPress={() => startEdit(m)}
                    android_ripple={{ color: "rgba(255,255,255,0.08)" }}
                  >
                    <Text style={[styles.markerName, { fontSize: densityVars.nameSize }, disabled && styles.dimText]}>
                      {m.name}
                    </Text>
                    <Text style={[styles.markerMeta, { fontSize: densityVars.metaSize }, disabled && styles.dimText]}>
                      {pad2(m.hour)}:{pad2(m.minute)}
                    </Text>
                  </Pressable>

                  <Text style={[styles.markerCountdown, { fontSize: densityVars.countdownSize }, disabled && styles.dimText]}>
                    {formatCountdown(countdowns[m.id] ?? 0)}
                  </Text>

                  <TouchableOpacity onPress={() => deleteMarker(m.id)} style={styles.deleteChip} activeOpacity={0.8}>
                    <Text style={styles.deleteChipText}>✕</Text>
                  </TouchableOpacity>
                </View>
              );
            })}
          </View>
        </View>

        {/* NOTIFICATIONS CARD (bottom) */}
        <View style={[styles.glassCard, styles.card]}>
          <View style={styles.cardHeaderRow}>
            <Text style={styles.cardTitle}>Notifications</Text>

            <TouchableOpacity
              onPress={toggleNotificationsMaster}
              style={[styles.togglePill, notificationsEnabled && Platform.OS !== "web" && styles.togglePillOn]}
              activeOpacity={0.85}
            >
              <Text style={[styles.togglePillText, notificationsEnabled && Platform.OS !== "web" && styles.togglePillTextOn]}>
                {Platform.OS === "web" ? "Mobile only" : notificationsEnabled ? "On" : "Off"}
              </Text>
            </TouchableOpacity>
          </View>

          <View style={styles.notifRow}>
            <Text style={styles.notifLabel}>Reminder</Text>

            <View style={styles.stepper}>
              <TouchableOpacity
                onPress={() => setReminderIndex((i) => Math.max(0, i - 1))}
                style={styles.stepBtn}
                activeOpacity={0.85}
              >
                <Text style={styles.stepBtnText}>−</Text>
              </TouchableOpacity>

              <View style={styles.stepValue}>
                <Text style={styles.stepValueText}>{REMINDER_OPTIONS[reminderIndex]} min</Text>
              </View>

              <TouchableOpacity
                onPress={() => setReminderIndex((i) => Math.min(REMINDER_OPTIONS.length - 1, i + 1))}
                style={styles.stepBtn}
                activeOpacity={0.85}
              >
                <Text style={styles.stepBtnText}>+</Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              onPress={manualReschedule}
              style={[styles.ghostBtnSmall, Platform.OS === "web" && { opacity: 0.5 }]}
              activeOpacity={0.85}
              disabled={Platform.OS === "web"}
            >
              <Text style={styles.ghostBtnSmallText}>Refresh</Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={testNotification}
              style={[styles.ghostBtnSmall, Platform.OS === "web" && { opacity: 0.5 }]}
              activeOpacity={0.85}
              disabled={Platform.OS === "web"}
            >
              <Text style={styles.ghostBtnSmallText}>Test 5s</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.notifHint}>
            {Platform.OS === "web"
              ? "Notifications require iOS/Android."
              : "Toggle 🔔 per marker to include it in alerts."}
          </Text>

          {notifStatus ? (
            <Text style={[styles.notifHint, { marginTop: 6 }]}>
              {notifStatus} • Total scheduled: {scheduledCount}
            </Text>
          ) : null}
        </View>

        <View style={{ height: 28 }} />
      </ScrollView>
    </View>
  );
}

/* -------------------- APP STYLES -------------------- */

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG_BASE },

  scrollContent: {
    paddingTop: 48,
    paddingHorizontal: 16,
    gap: 12,
    paddingBottom: 24,
  },

  glassCard: {
    backgroundColor: "rgba(10, 12, 11, 0.52)",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    shadowColor: "#000",
    shadowOpacity: 0.28,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },

  clockCard: {
    paddingTop: 16,
    paddingBottom: 12,
    paddingHorizontal: 18,
    alignItems: "center",
  },
  clockLabel: {
    color: ACCENT,
    letterSpacing: 3,
    fontSize: 12,
    marginBottom: 6,
    fontWeight: "800",
  },

  nextCard: {
    width: "100%",
    marginTop: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  nextTitle: {
    color: "rgba(255,255,255,0.70)",
    fontWeight: "900",
    fontSize: 12,
    letterSpacing: 1,
    marginBottom: 8,
  },
  nextItem: {
    color: "rgba(245,250,255,0.88)",
    fontWeight: "800",
    fontSize: 14,
  },

  editingPill: {
    marginTop: 10,
    backgroundColor: "rgba(88,164,110,0.14)",
    borderWidth: 1,
    borderColor: "rgba(88,164,110,0.22)",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  editingPillText: { color: ACCENT, fontSize: 12, fontWeight: "800" },

  notifRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    marginTop: 4,
    flexWrap: "wrap",
  },
  notifLabel: {
    color: "rgba(255,255,255,0.78)",
    fontWeight: "900",
    fontSize: 13,
  },
  notifHint: {
    marginTop: 10,
    color: "rgba(255,255,255,0.55)",
    fontWeight: "700",
    fontSize: 12,
    lineHeight: 16,
  },

  togglePill: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
  },
  togglePillOn: {
    backgroundColor: "rgba(88,164,110,0.16)",
    borderColor: "rgba(88,164,110,0.30)",
  },
  togglePillText: {
    color: "rgba(255,255,255,0.72)",
    fontWeight: "900",
    fontSize: 12,
    letterSpacing: 1,
  },
  togglePillTextOn: { color: ACCENT },

  stepper: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 12,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    backgroundColor: "rgba(255,255,255,0.06)",
  },
  stepBtn: { width: 34, height: 34, alignItems: "center", justifyContent: "center" },
  stepBtnText: { color: "rgba(245,250,255,0.92)", fontWeight: "900", fontSize: 18 },
  stepValue: {
    paddingHorizontal: 12,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  stepValueText: { color: "rgba(245,250,255,0.92)", fontWeight: "900", fontSize: 13, letterSpacing: 1 },

  ghostBtnSmall: {
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  ghostBtnSmallText: { color: "rgba(255,255,255,0.88)", fontWeight: "900", fontSize: 12, letterSpacing: 1 },

  realCard: { paddingVertical: 14, paddingHorizontal: 16, alignItems: "center" },
  realLabel: {
    color: ACCENT_DIM,
    letterSpacing: 4,
    fontSize: 11,
    marginBottom: 10,
    fontWeight: "900",
  },
  realBox: {
    width: 180,
    height: 56,
    borderRadius: 18,
    backgroundColor: "rgba(14,26,20,0.78)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
    alignItems: "center",
    justifyContent: "center",
  },
  realText: { color: "rgba(245,250,255,0.92)", fontSize: 22, fontWeight: "900", letterSpacing: 2 },

  card: { padding: 14 },
  cardHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginBottom: 10,
  },
  cardTitle: { color: "#ffffff", fontSize: 16, fontWeight: "900" },
  cardSubtitle: { color: "rgba(255,255,255,0.60)", fontSize: 12, fontWeight: "800" },

  input: {
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 12,
    color: "#fff",
    fontSize: 16,
    marginBottom: 12,
  },

  timeRow: { flexDirection: "row", alignItems: "flex-end", flexWrap: "wrap", gap: 10 },
  timeBox: {
    width: 76,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 10,
  },
  timeBoxLabel: { color: "rgba(255,255,255,0.55)", fontSize: 11, fontWeight: "800", marginBottom: 6, letterSpacing: 1 },
  timeInput: { color: "#fff", fontSize: 18, fontWeight: "900", textAlign: "center", paddingVertical: 0 },
  colon: { color: "rgba(255,255,255,0.70)", fontSize: 20, fontWeight: "900", paddingBottom: 12 },

  primaryBtn: { backgroundColor: ACCENT, borderRadius: 14, paddingVertical: 12, paddingHorizontal: 16, justifyContent: "center", alignItems: "center" },
  primaryBtnText: { color: "#0b1511", fontWeight: "900", fontSize: 16 },

  ghostBtn: {
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  ghostBtnText: { color: "rgba(255,255,255,0.88)", fontWeight: "900", fontSize: 14 },

  markerRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    gap: 10,
  },
  markerRowDisabled: { backgroundColor: "rgba(255,255,255,0.04)", borderColor: "rgba(255,255,255,0.08)" },

  markerName: { color: "#ffffff", fontWeight: "900" },
  markerMeta: { color: "rgba(255,255,255,0.62)", marginTop: 2, fontWeight: "800" },
  markerCountdown: { color: "#ffffff", fontWeight: "900" },
  dimText: { opacity: 0.55 },

  checkBox: {
    width: 26,
    height: 26,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
    backgroundColor: "rgba(0,0,0,0.18)",
    alignItems: "center",
    justifyContent: "center",
  },
  checkBoxOn: { borderColor: "rgba(88,164,110,0.55)", backgroundColor: "rgba(88,164,110,0.12)" },
  checkMark: { color: ACCENT, fontWeight: "900", fontSize: 16, lineHeight: 18 },

  bellBtn: {
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
    backgroundColor: "rgba(255,255,255,0.04)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  bellText: { fontSize: 16 },

  deleteChip: {
    marginLeft: 6,
    width: 34,
    height: 34,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.07)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  deleteChipText: { color: "rgba(255,255,255,0.80)", fontSize: 16, fontWeight: "900" },

  segment: {
    flexDirection: "row",
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    borderRadius: 12,
    overflow: "hidden",
  },
  segmentBtn: { paddingVertical: 6, paddingHorizontal: 10 },
  segmentBtnActive: { backgroundColor: "rgba(88,164,110,0.22)" },
  segmentText: { color: "rgba(255,255,255,0.70)", fontWeight: "900", fontSize: 12 },
  segmentTextActive: { color: ACCENT },
});
