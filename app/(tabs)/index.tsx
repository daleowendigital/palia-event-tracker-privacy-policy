import { StatusBar as ExpoStatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  Animated,
  Easing,
  LayoutAnimation,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  Linking,
  TouchableOpacity,
  NativeModules,
  UIManager,
  View,
  useWindowDimensions,
  Alert,
  Image,
  Share,
} from "react-native";
import * as Notifications from "expo-notifications";
import * as NavigationBar from "expo-navigation-bar";
import * as Application from "expo-application";
import * as Device from "expo-device";
import { Ionicons, MaterialIcons } from "@expo/vector-icons";
import Svg, {
  Circle,
  ClipPath,
  Defs,
  G,
  Line,
  LinearGradient,
  Path,
  RadialGradient,
  Rect,
  Stop,
  Text as SvgText,
} from "react-native-svg";
import { BlurView } from "expo-blur";
import { useKeepAwake } from "expo-keep-awake";
import { FISH_JSON_VERSION } from "../../src/fishVersion";





// SECTION 1) NOTIFICATIONS: DISPLAY BEHAVIOR

// SECTION 1.1) Global handler

if (Platform.OS !== "web") {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: true,
      shouldSetBadge: true,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}





// SECTION 2) TYPES

// SECTION 2.1) Marker + UI types

type Marker = {
  id: string;
  name: string;
  hour: number; // Palia hour 0-23
  minute: number; // Palia minute 0-59
  enabled: boolean; // show/hide on clock + Next Event
  notify: boolean; // include in notifications (only if enabled too)

  notes?: string; // optional user notes/details (shown in Event Setup)

  // Optional duration window (for "Now" / active events)
  // If missing/false, this is treated as a one-time event (notification + Next only).
  hasRange?: boolean;
  endHour?: number;   // 0-23
  endMinute?: number; // 0-59

  // Fish-only (from fish.json enrichment)
  imageUrl?: string;
};

type FishEntry = {
  id: string;
  title: string;
  url?: string;
  description?: string;
  rarity?: string;
  appears?: string;
  locations?: string[];
  biomes?: string[];
  bestBait?: string[];
  value?: { basic: number | null; quality: number | null };
  imageUrl?: string;
};

// SECTION 2.X) Fish wiki cleanup
// Some wiki pages are category/group pages (eg. "Bass") and are not catchable fish.
// We block them here so they never become Events.
const FISH_BLOCKLIST_IDS = new Set<string>([
  "bass",
]);

const FISH_BLOCKLIST_TITLES = new Set<string>([
  "bass",
]);

function isBlockedFishEntry(f: FishEntry): boolean {
  const id = String(f?.id ?? "").trim().toLowerCase();
  const title = String(f?.title ?? "").trim().toLowerCase();
  if (!id || !title) return true; // malformed -> don't render

  return FISH_BLOCKLIST_IDS.has(id) || FISH_BLOCKLIST_TITLES.has(title);
}

function normalizeRemoteFish(raw: any): FishEntry[] {
  if (!raw) return [];

  // Common shapes:
  // 1) [ ... ]
  // 2) { fish: [ ... ] } / { items: [ ... ] } / { data: [ ... ] }
  // 3) { fish: { id1: {...}, id2: {...} } } (object map) and similar

  const pickArray = (v: any) => (Array.isArray(v) ? v : null);
  const pickMapValues = (v: any) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    try {
      return Object.values(v);
    } catch {
      return null;
    }
  };

  let arr: any[] =
    (Array.isArray(raw) ? raw : null) ??
    pickArray(raw.fish) ??
    pickArray(raw.items) ??
    pickArray(raw.data) ??
    pickMapValues(raw.fish) ??
    pickMapValues(raw.items) ??
    pickMapValues(raw.data) ??
    [];

  if (!Array.isArray(arr)) arr = [];

  // Only keep objects that at least have id + title
  return arr
    .filter((x: any) => x && typeof x === "object" && typeof x.id === "string" && typeof x.title === "string")
    .map((x: any) => {
      // Accept a few possible keys for image URLs, but normalize to `imageUrl`.
      const imageUrl =
        (typeof x.imageUrl === "string" ? x.imageUrl : null) ??
        (typeof x.image_url === "string" ? x.image_url : null) ??
        (typeof x.image === "string" ? x.image : null) ??
        (typeof x.thumb === "string" ? x.thumb : null) ??
        null;

      return {
        ...(x as any),
        imageUrl: imageUrl || undefined,
      } as FishEntry;
    });
}

function fishAppearsToWindow(appearsRaw: string | undefined | null): { hour: number; minute: number; hasRange: boolean; endHour?: number; endMinute?: number } {
  const s = String(appearsRaw ?? "").toLowerCase();

  // Defaults
  if (s.includes("morning")) return { hour: 3, minute: 0, hasRange: true, endHour: 6, endMinute: 0 };
  if (s.includes("day")) return { hour: 6, minute: 0, hasRange: true, endHour: 18, endMinute: 0 };
  if (s.includes("evening")) return { hour: 18, minute: 0, hasRange: true, endHour: 21, endMinute: 0 };
  if (s.includes("night")) return { hour: 21, minute: 0, hasRange: true, endHour: 3, endMinute: 0 };

  // "Any Time" (or unknown): treat as a simple one-time entry (doesn't become a constant 'Now' event)
  return { hour: 0, minute: 0, hasRange: false };
}

function buildFishNotes(f: FishEntry) {
  const lines: string[] = [];
  if (f.description) lines.push(String(f.description).trim());
  lines.push("");
  if (f.rarity) lines.push(`Rarity: ${f.rarity}`);
  if (f.appears) lines.push(`Appears: ${f.appears}`);
  if (Array.isArray(f.locations) && f.locations.length) lines.push(`Locations: ${f.locations.join(", ")}`);
  if (Array.isArray(f.biomes) && f.biomes.length) lines.push(`Biomes: ${f.biomes.join(", ")}`);
  if (Array.isArray(f.bestBait) && f.bestBait.length) lines.push(`Best bait: ${f.bestBait.join(", ")}`);
  if (f.value && (f.value.basic != null || f.value.quality != null)) {
    lines.push(`Value: ${f.value.basic ?? "—"} (basic), ${f.value.quality ?? "—"} (quality)`);
  }
  if (f.url) {
    lines.push("");
    lines.push(`Wiki: ${f.url}`);
  }
  return lines.join("\n").trim();
}



// SECTION 2.2) Notification preference types

// Reminder lead-times are REAL seconds before the marker fires.
const REMINDER_OPTIONS = [0, 30, 60, 120, 300, 600] as const;
type ReminderLeadSeconds = (typeof REMINDER_OPTIONS)[number];

type NotifPrefs = {
  enabled: boolean;
  reminderLeadSeconds: ReminderLeadSeconds;
};

// SECTION 2.3) Scheduling grouping types

// We schedule notifications PER PALIA TIME (HH:MM), not per marker.
type TimeKey = string; // "HH:MM"

type TimeGroup = {
  timeKey: TimeKey;
  hour: number;
  minute: number;
  markers: Marker[]; // enabled+notified markers at this HH:MM
};





// SECTION 3) THEME + STORAGE KEYS

// SECTION 3.1) Colors + fonts

const BG_BASE = "#081B33";

/**
 * Accent palette
 * - ACCENT = warm lantern gold (primary highlights: buttons, selected pills, key labels)
 * - ENABLED_ACCENT = muted sage (ONLY for true "enabled" states)
 */
const ACCENT_RGB = "255,214,154"; // soft gold / lantern light
const ACCENT = `rgba(${ACCENT_RGB},1)`;

const ENABLED_RGB = "122,152,132"; // muted sage (less "status green")
const ENABLED_ACCENT = `rgba(${ENABLED_RGB},1)`;

/**
 * Warm whites (so the UI stops looking like a dentist waiting room)
 */
const SOFT_WHITE = "rgba(252,248,240,0.92)";
const SOFT_WHITE_SOLID = "rgba(252,248,240,1)";
const SOFT_WHITE_DIM = "rgba(252,248,240,0.78)";
const SOFT_WHITE_FAINT = "rgba(252,248,240,0.62)";
const SOFT_WHITE_GHOST = "rgba(252,248,240,0.35)";

/**
 * Neutral surfaces (avoid the old green-tinted chips)
 */
const PILL_BG = "rgba(12,18,26,0.78)";

const FONT_ROUNDED =
  Platform.select({
    web: "system-ui",
    ios: "SF Pro Rounded",
    android: "sans-serif-medium",
    default: "System",
  }) ?? "System";




// SECTION 3.2) Storage keys

const STORAGE_MARKERS = "palia_markers_v1";
const STORAGE_REPEATABLE_NOTIF_DEFAULTED = "palia_repeatable_notif_defaulted_v1";
const STORAGE_NOTIF_PREFS = "palia_notif_prefs_v4";
const STORAGE_NOTIF_DEFAULTED = "palia_notif_defaulted_v1";
const STORAGE_TEXT_SIZE_MODE = "palia_text_size_mode_v1";
const NEXT_TIME_COUNT_KEY = "next_time_count";
const HELP_DIAGNOSTICS_OPTIN_KEY = "help_include_diagnostics_v1";

// Fish cache keys should bust when the remote fish JSON version changes
const STORAGE_REMOTE_FISH_CACHE = `palia_remote_fish_cache_${FISH_JSON_VERSION}`;
const STORAGE_REMOTE_FISH_FETCHED_AT = `palia_remote_fish_fetched_at_${FISH_JSON_VERSION}`;
const REMOTE_FISH_REFRESH_MS = 6 * 60 * 60 * 1000; // 6 hours


// Remote data sources (hosted JSON you control)
//
// Primary strategy:
// - Web dev: pull from /public/fish.json (fast + no CORS headaches)
// - Native + prod: pull from your hosted GitHub Pages JSON
const FISH_URL_REMOTE = `https://daleowendigital.github.io/palia-event-tracker-privacy-policy/fish.json?v=${encodeURIComponent(FISH_JSON_VERSION)}`;
const FISH_URL_RAW_MAIN = `https://raw.githubusercontent.com/daleowendigital/palia-event-tracker-privacy-policy/main/fish.json?v=${encodeURIComponent(FISH_JSON_VERSION)}`;
const FISH_URL_RAW_MASTER = `https://raw.githubusercontent.com/daleowendigital/palia-event-tracker-privacy-policy/master/fish.json?v=${encodeURIComponent(FISH_JSON_VERSION)}`;
const FISH_URL_WEB_LOCAL = `/fish.json?v=${encodeURIComponent(FISH_JSON_VERSION)}`;

// Primary URL by platform (web uses local file first)
const FISH_URL = Platform.OS === "web" ? FISH_URL_WEB_LOCAL : FISH_URL_REMOTE;


// Text size (accessibility)
type TextSizeMode = "small" | "medium" | "large";

// What’s New banner (persist dismissal across restarts)
const WHATS_NEW_ID = "appday12_whatsnew_001";
const STORAGE_WHATSNEW_DISMISSED_ID = "whats_new_dismissed_id_v1";


const WHATS_NEW_ITEMS: string[] = [
  "'What’s New' banner",
  "Dismissable banner to alert when notifications are off",
  "Quick link on 'Next' card to 'Event Setup'",
];






const CLOSED_TEST_POPUP_SEEN_KEY = "closed_test_popup_seen_v1";
// SECTION 4) DEFAULT MARKERS

// SECTION 4.1) Base marker set

const BASE_DEFAULT_MARKERS: Marker[] = [
  { id: "default_day_0600", name: "Day Time", hour: 6, minute: 0, enabled: true, notify: true, notes: "Day time in Palia starts at 6am and ends at 6pm." },
  { id: "default_evening_1800", name: "Evening Time", hour: 18, minute: 0, enabled: true, notify: true, notes: "Evening time in Palia starts at 6pm and ends at 9pm." },
  { id: "default_night_2100", name: "Night Time", hour: 21, minute: 0, enabled: true, notify: true, notes: "Night time in Palia starts at 9pm and ends at 3am." },
  { id: "default_morning_0300", name: "Morning Time", hour: 3, minute: 0, enabled: true, notify: true, notes: "Morning time in Palia starts at 3am and ends at 6am." },
];

// SECTION 4.2) Repeatable Events seed markers (id prefix: repeat_)

const BASE_REPEATABLE_MARKERS: Marker[] = [
  // One-time (no duration window)
  { id: "repeat_shipping_bin_home_0600", name: "Shipping Bin - Home Plot", hour: 6, minute: 0, enabled: false, notify: false, notes: "The shipping bin empties at 6am and 6pm Palia time." },
  { id: "repeat_shipping_bin_home_1800", name: "Shipping Bin - Home Plot", hour: 18, minute: 0, enabled: false, notify: false, notes: "The shipping bin empties at 6am and 6pm Palia time." },
  { id: "repeat_gift_collection_home_0000", name: "Gift Collection - Home Plot", hour: 0, minute: 0, enabled: false, notify: false, notes: "Collect a gift from the Ancient Rock Garden." },
  { id: "repeat_farm_reset_home_0600", name: "Crop Growth - Home Plot", hour: 6, minute: 0, enabled: false, notify: false, notes: "Planted trees, flowers and planted crops will grow." },

  // Ranges (show in "Now" while active)
  { id: "repeat_decor_reset_underground_1800", name: "Exclusive Décor - Underground", hour: 18, minute: 0, hasRange: true, endHour: 3, endMinute: 0, enabled: false, notify: false, notes: "Purchase exclusive décor from The Underground." },
  { id: "repeat_hotpot_underground_1800", name: "Play Hotpot - Underground", hour: 18, minute: 0, hasRange: true, endHour: 3, endMinute: 0, enabled: false, notify: false, notes: "Hotpot is a card-style game you and up to 3 other players can play in The Underground." },
  { id: "repeat_grove_bahari_0000", name: "Flow Tree Grove - Bahari Bay", hour: 0, minute: 0, hasRange: true, endHour: 3, endMinute: 0, enabled: false, notify: false, notes: "The flow tree grove will reveal itself at midnight every Palia night in a random location in Bahari Bay." },
  { id: "repeat_piksii_elderwood_2200", name: "Piksii Blossom Bounce - Elderwood", hour: 22, minute: 0, hasRange: true, endHour: 23, endMinute: 10, enabled: false, notify: false, notes: "The Piksii Blossom Bounce is a repeatable jump quest event in the Elderwood Deep Woods that allows players to earn Elderwood flower seeds and other rewards." },
  { id: "repeat_flowers_kilima_1200", name: "Flowers Bloom - Kilima Valley", hour: 12, minute: 0, hasRange: true, endHour: 16, endMinute: 0, enabled: false, notify: false, notes: "The Flower Bloom event is a dynamic cooperative/singleplayer event in Kilima Valley that allows players to earn flower seeds and other rewards." },
];



const REPEATABLE_CANON_BY_ID = new Map<string, Marker>(BASE_REPEATABLE_MARKERS.map((m) => [m.id, m]));

function ensureRepeatableDefaults(input: Marker[]): Marker[] {
  // Ensure repeatable seed markers exist AND stay in sync with the canonical defaults.
  // We preserve the user's toggles (enabled/notify) so updates don't silently change their setup.
  const score = (m: Marker) => (m.enabled ? 2 : 0) + (m.notify ? 1 : 0);
  const best = new Map<string, Marker>();

  for (const m of input) {
    const prev = best.get(m.id);
    if (!prev || score(m) > score(prev)) best.set(m.id, m);
  }

  // Start with de-duped markers, then "heal" repeatables to match canonical timing/range fields.
  const out = Array.from(best.values()).map((m) => {
    if (!String(m.id).startsWith("repeat_")) return m;

    const canon = REPEATABLE_CANON_BY_ID.get(m.id);
    if (!canon) return m;

    return {
      ...canon,
      enabled: m.enabled,
      notify: m.notify,
    };
  });

  const ids = new Set(out.map((m) => m.id));

  for (const d of BASE_REPEATABLE_MARKERS) {
    if (!ids.has(d.id)) {
      out.push(d);
      ids.add(d.id);
    }
  }

  return out;
}


const DEFAULT_CANON_BY_ID = new Map<string, Marker>(BASE_DEFAULT_MARKERS.map((m) => [m.id, m]));

function ensureDefaultDefaults(input: Marker[]): Marker[] {
  // Keep default seed markers in sync (including notes), while preserving user toggles.
  const score = (m: Marker) => (m.enabled ? 2 : 0) + (m.notify ? 1 : 0);
  const best = new Map<string, Marker>();

  for (const m of input) {
    const prev = best.get(m.id);
    if (!prev || score(m) > score(prev)) best.set(m.id, m);
  }

  const out = Array.from(best.values()).map((m) => {
    if (!String(m.id).startsWith("default_")) return m;

    const canon = DEFAULT_CANON_BY_ID.get(m.id);
    if (!canon) return m;

    const preservedNotes =
      typeof m.notes === "string" && m.notes.trim().length > 0 ? m.notes : (canon as any).notes;

    return {
      ...canon,
      enabled: m.enabled,
      notify: m.notify,
      ...(preservedNotes ? { notes: preservedNotes } : {}),
    };
  });

  const ids = new Set(out.map((m) => m.id));
  for (const d of BASE_DEFAULT_MARKERS) {
    if (!ids.has(d.id)) {
      out.push(d);
      ids.add(d.id);
    }
  }

  return out;
}


// Legacy defaults (so we can auto-migrate “old defaults only” installs)

// SECTION 4.3) Default export set

const DEFAULT_MARKERS: Marker[] = [...BASE_DEFAULT_MARKERS, ...BASE_REPEATABLE_MARKERS];





// SECTION 5) TIME + SMALL HELPERS

// SECTION 5.1) Formatting helpers

function pad2(n: number) {
  return n.toString().padStart(2, "0");
}

// Split stored marker name into { eventName, location }.
// Stored as "Event Name - Location" (location optional).
// IMPORTANT: locations can contain " - " internally, so we split on the FIRST separator only.
function splitNameLocation(full: string) {
  const sep = " - ";
  const s = full || "";
  const i = s.indexOf(sep);
  if (i === -1) return { eventName: s, location: "" };
  const eventName = s.slice(0, i).trim();
  const location = s.slice(i + sep.length).trim();
  return { eventName: eventName || s, location };
}

function formatCountdown(totalSeconds: number) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  return `${pad2(m)}:${pad2(s)}`;
}

function format12hTime(hour24: number, minute: number) {
  const mer = hour24 >= 12 ? "PM" : "AM";
  const h = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${h}:${pad2(minute)} ${mer}`;
}

function formatReminderChip(seconds: number) {
  if (seconds === 0) return "0m";
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m`;
}

function formatReminderBodyPrefix(seconds: number) {
  if (seconds === 0) return "Now";
  return `${formatReminderChip(seconds)} before`;
}

// SECTION 5.2) Palia time conversion

// Palia day = 1 real hour (1440 palia minutes = 3600 real seconds)
function getPaliaMinutesNow() {
  const now = new Date();
  const secondsIntoHour = now.getMinutes() * 60 + now.getSeconds() + now.getMilliseconds() / 1000;
  return (secondsIntoHour / 3600) * 1440; // 0..1440
}

function getPaliaTime() {
  const paliaMinutesTotal = getPaliaMinutesNow();
  const hour = Math.floor(paliaMinutesTotal / 60) % 24;
  const minute = Math.floor(paliaMinutesTotal % 60);
  const formatted24 = `${pad2(hour)}:${pad2(minute)}`;
  const formatted12 = format12hTime(hour, minute);
  return { hour, minute, formatted24, formatted12 };
}

// SECTION 5.3) Next-occurrence timing

// Millisecond-precise time until the next occurrence of a Palia HH:MM.
function getMsUntilNextPaliaTime(targetHour: number, targetMinute: number) {
  const currentPaliaMinutes = getPaliaMinutesNow();
  let targetPaliaMinutes = targetHour * 60 + targetMinute;

  if (targetPaliaMinutes <= currentPaliaMinutes) targetPaliaMinutes += 1440;

  const paliaMinutesRemaining = targetPaliaMinutes - currentPaliaMinutes;
  const realMsRemaining = (paliaMinutesRemaining / 1440) * 3600 * 1000;

  return Math.max(0, realMsRemaining);
}

// Seconds version for countdown UI (rounded up so it doesn't show "00:00" early).
function getSecondsUntilNextPaliaTime(targetHour: number, targetMinute: number) {
  return Math.ceil(getMsUntilNextPaliaTime(targetHour, targetMinute) / 1000);
}

// SECTION 5.4) Misc helpers

function makeId() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}


function isProtectedMarkerId(id: string) {
  const s = String(id);
  return s.startsWith("default_") || s.startsWith("repeat_") || s.startsWith("fish_");
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

function errMsg(e: unknown) {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const msg = (e as { message?: unknown }).message;
    if (typeof msg === "string") return msg;
  }
  return String(e);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function toIntInRange(v: unknown, min: number, max: number, fallback: number) {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  return Math.max(min, Math.min(max, i));
}

const REMINDER_OPTIONS_ARR: ReadonlyArray<number> = REMINDER_OPTIONS;

function isReminderLeadSeconds(v: unknown): v is ReminderLeadSeconds {
  return typeof v === "number" && REMINDER_OPTIONS_ARR.includes(v);
}

function snapReminderLeadSeconds(sec: number): ReminderLeadSeconds {
  const snapped = REMINDER_OPTIONS.reduce(
    (best, v) => (Math.abs(v - sec) < Math.abs(best - sec) ? v : best),
    REMINDER_OPTIONS[0]
  ) as ReminderLeadSeconds;
  return snapped;
}

function normalizeStoredMarker(v: unknown): Marker | null {
  if (!isRecord(v)) return null;

  const idRaw = v["id"];
  const nameRaw = v["name"];

  const id = typeof idRaw === "string" && idRaw.trim() ? idRaw : makeId();
  const name = typeof nameRaw === "string" && nameRaw.trim() ? nameRaw : "Event";

  const hour = toIntInRange(v["hour"], 0, 23, 0);
  const minute = toIntInRange(v["minute"], 0, 59, 0);

  const enabledRaw = v["enabled"];
  const notifyRaw = v["notify"];

  const enabled = typeof enabledRaw === "boolean" ? enabledRaw : true;
  const notify = typeof notifyRaw === "boolean" ? notifyRaw : true;

  const hasRangeRaw = v["hasRange"];
  const hasRange = typeof hasRangeRaw === "boolean" ? hasRangeRaw : false;

  // Only keep end times if range is explicitly enabled.
  const endHour = hasRange ? toIntInRange(v["endHour"], 0, 23, hour) : undefined;
  const endMinute = hasRange ? toIntInRange(v["endMinute"], 0, 59, minute) : undefined;

    const notesRaw = v["notes"];
  const notes = typeof notesRaw === "string" ? notesRaw.trim().slice(0, 600) : "";

  return { id, name, hour, minute, enabled, notify, notes: notes || undefined, hasRange, endHour, endMinute };
}





// SECTION 6) NOTIFICATION UTILITIES

// SECTION 6.1) Android channel

async function ensureAndroidChannel() {
  if (Platform.OS !== "android") return;

  await Notifications.setNotificationChannelAsync("palia", {
    name: "Palia Event Tracker",
    // MAX gives you the best chance of heads-up delivery (user/device can still override).
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0],
    lightColor: "#D6A64B", // gold accent
    
  });
}

// SECTION 6.2) Permissions

async function ensurePermission(requestIfNeeded: boolean) {
  if (Platform.OS === "web") return { ok: false as const, status: "web" as const };

  if (Platform.OS === "android") await ensureAndroidChannel();

  const existing = await Notifications.getPermissionsAsync();
  if (existing.status === "granted") return { ok: true as const, status: existing.status };

  if (!requestIfNeeded) return { ok: false as const, status: existing.status };

  const req = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowBadge: true, allowSound: true },
  });
  return { ok: req.status === "granted", status: req.status };
}


// SECTION 6.3) Web notification helpers (desktop notifications while the tab is open)

async function ensureWebNotificationPermission() {
  if (Platform.OS !== "web") return { ok: false as const, status: "not_web" as const };

  // Browser Notification API (requires HTTPS or localhost)
  const anyWin = globalThis as any;
  const Notif = anyWin?.Notification;

  if (!Notif) return { ok: false as const, status: "unsupported" as const };

  if (Notif.permission === "granted") return { ok: true as const, status: "granted" as const };
  if (Notif.permission === "denied") return { ok: false as const, status: "denied" as const };

  try {
    const res = await Notif.requestPermission();
    return { ok: res === "granted", status: res as "granted" | "denied" | "default" };
  } catch {
    return { ok: false as const, status: "error" as const };
  }
}

function fireWebNotification(title: string, body: string) {
  if (Platform.OS !== "web") return;

  const anyWin = globalThis as any;
  const Notif = anyWin?.Notification;

  if (!Notif) return;
  if (Notif.permission !== "granted") return;

  try {
    // Some browsers may not like newline-heavy bodies. Still fine.
    // eslint-disable-next-line no-new
    new Notif(title, { body });
  } catch {
    // ignore
  }
}







// SECTION 7) NOTIFICATIONS CORE (ONE NOTIF PER PALIA TIME)

// SECTION 7.1) Grouping helpers

function timeKeyFor(hour: number, minute: number) {
  return `${pad2(hour)}:${pad2(minute)}`;
}

function groupEnabledMarkersByTime(enabledMarkers: Marker[]): TimeGroup[] {
  const map = new Map<string, Marker[]>();

  for (const m of enabledMarkers) {
    const key = timeKeyFor(m.hour, m.minute);
    const arr = map.get(key);
    if (arr) arr.push(m);
    else map.set(key, [m]);
  }

  const groups: TimeGroup[] = [];
  for (const [key, markers] of map.entries()) {
    const [hh, mm] = key.split(":").map((x) => parseInt(x, 10));
    groups.push({
      timeKey: key,
      hour: hh,
      minute: mm,
      markers: markers.slice().sort((a, b) => a.name.localeCompare(b.name)),
    });
  }

  groups.sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));
  return groups;
}

// SECTION 7.2) Notification content builder

function buildGroupNotificationText(group: TimeGroup, leadSeconds: ReminderLeadSeconds) {
  const paliaLabel12 = format12hTime(group.hour, group.minute);
  const prefix = formatReminderBodyPrefix(leadSeconds);

  const names = group.markers.map((m) => m.name);

  const MAX_LINES = 5;
  const shown = names.slice(0, MAX_LINES);
  const remaining = Math.max(0, names.length - shown.length);

  const lines = shown.map((n) => `• ${n}`);
  if (remaining > 0) lines.push(`• +${remaining} more`);

  const title = `${prefix} • ${paliaLabel12}`;
  const body = lines.join("\n");

  return { title, body, paliaLabel12 };
}

// SECTION 7.3) Scheduling (DATE triggers)

async function scheduleTimeGroupOccurrences(params: {
  group: TimeGroup;
  reminderLeadSeconds: ReminderLeadSeconds;
  occurrences: number;
}) {
  const { group, reminderLeadSeconds, occurrences } = params;

  const baseMs = getMsUntilNextPaliaTime(group.hour, group.minute);
  const leadMs = reminderLeadSeconds * 1000;

  const ids: string[] = [];
  const MAX_CYCLES_SCAN = Math.max(occurrences + 10, 16);

  let cycle = 0;
  while (ids.length < occurrences && cycle < MAX_CYCLES_SCAN) {
    const eventInMs = baseMs + cycle * 3600 * 1000; // repeats every real hour
    const fireInMs = eventInMs - leadMs;

    // Skip if reminder window already passed OR basically "now" (prevents instant-fire spam on resync).
    if (fireInMs > 1200) {
      const fireAt = new Date(Date.now() + fireInMs);
      const { title, body, paliaLabel12 } = buildGroupNotificationText(group, reminderLeadSeconds);

      const trigger: Notifications.DateTriggerInput =
        Platform.OS === "android"
          ? { type: Notifications.SchedulableTriggerInputTypes.DATE, date: fireAt, channelId: "palia" }
          : { type: Notifications.SchedulableTriggerInputTypes.DATE, date: fireAt };

      const id = await Notifications.scheduleNotificationAsync({
        content: {
          title,
          body,
          sound: "default",
          // Android: push delivery importance as high as we can.
          priority: Platform.OS === "android" ? Notifications.AndroidNotificationPriority.MAX : undefined,
          data: {
            type: "time_group",
            timeKey: group.timeKey,
            paliaTime12: paliaLabel12,
            reminderLeadSeconds,
            markerIds: group.markers.map((m) => m.id),
            markerNames: group.markers.map((m) => m.name),
            scheduledForEpochMs: fireAt.getTime(),
          },
        },
        trigger,
      });

      ids.push(id);
    }

    cycle += 1;
  }

  return ids;
}





// SECTION 8) BACKGROUND SPARKLES

// SECTION 8.1) Component

const BackgroundSparkles = React.memo(function BackgroundSparkles() {
  const { width, height } = useWindowDimensions();

  const VIGNETTE_OP = 0.45;

  // Tiny "delight": ultra-slow global twinkle on the star layer (subtle, low opacity).
  const twinkle = useRef(new Animated.Value(0)).current;

  // Micro-delight: rare, opacity-only brighten pulse on a handful of random stars.
  // No movement. No interaction with the global twinkle. Just a tiny "alive" moment.
  const pulse = useRef(new Animated.Value(0)).current;
  const [pulseIdxs, setPulseIdxs] = useState<number[]>([]);

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(twinkle, {
          toValue: 1,
          duration: 12000,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(twinkle, {
          toValue: 0,
          duration: 16000,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ])
    );

    loop.start();
    return () => loop.stop();
  }, [twinkle]);

  const twinkleOpacity = useMemo(
    () =>
      twinkle.interpolate({
        inputRange: [0, 1],
        outputRange: [0.75, 1.0],
      }),
    [twinkle]
  );

  // 1.35× opacity boost when pulsing, otherwise 1.0×
  const pulseFactor = useMemo(
    () =>
      pulse.interpolate({
        inputRange: [0, 1],
        outputRange: [1.0, 2.5],
      }),
    [pulse]
  );

  const sparklePath = (cx: number, cy: number, r: number) => {
    const p = [
      `M ${cx} ${cy - r}`,
      `L ${cx + r * 0.35} ${cy - r * 0.35}`,
      `L ${cx + r} ${cy}`,
      `L ${cx + r * 0.35} ${cy + r * 0.35}`,
      `L ${cx} ${cy + r}`,
      `L ${cx - r * 0.35} ${cy + r * 0.35}`,
      `L ${cx - r} ${cy}`,
      `L ${cx - r * 0.35} ${cy - r * 0.35}`,
      "Z",
    ].join(" ");
    return p;
  };

  const rand01 = (seed: number) => {
    // deterministic pseudo-random in [0,1)
    const x = Math.sin(seed * 999.123 + 0.123) * 10000;
    return x - Math.floor(x);
  };

  const sparkles = useMemo(() => {
    // Density tuned for a 390x844-ish baseline, scaled by area.
    const BASE_AREA = 390 * 844;
    const area = Math.max(320 * 640, width * height);
    const baseCount = 170 * 2;
    const COUNT = Math.round(baseCount * (area / BASE_AREA));

    const arr: Array<{ x: number; y: number; si: number; op: number }> = [];

    for (let i = 0; i < COUNT; i++) {
      const x = rand01(i + 11) * width;
      const y = rand01(i + 97) * height;

      let si = 0.9 + rand01(i + 33) * 2.8;
      if (i % 13 === 0) si *= 1.7;
      if (i % 31 === 0) si *= 2.2;

      let op = (0.02 + rand01(i + 700) * 0.07) * 1.95;
      if (i % 11 === 0) op += 0.03;
      if (op > 0.26) op = 0.26;

      arr.push({ x, y, si, op });

    }
    return arr;
  }, [width, height]);
    // Pulse eligibility: avoid very dim stars (micro-delight should be perceptible)
    const PULSE_MIN_OP = 0.18;

    const eligibleIdxs = sparkles
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.op >= PULSE_MIN_OP)
      .map(({ i }) => i);

  // Every 30–45s: pick ~5 random stars and give them a quick opacity-only brighten pulse.
  useEffect(() => {
    if (!sparkles.length) return;

    let timer: any = null;
    let cancelled = false;

    const pickUniqueIdxs = (n: number) => {
      const count = Math.min(n, sparkles.length);
      const set = new Set<number>();
      while (set.size < count) set.add(Math.floor(Math.random() * sparkles.length));
      return Array.from(set);
    };

    const scheduleNext = () => {
      if (cancelled) return;
      const delayMs = 2000 + Math.floor(Math.random() * 5000); // 3–15s
      timer = setTimeout(() => {
        if (cancelled) return;

        const idxs = pickUniqueIdxs(25);
        setPulseIdxs(idxs);

        pulse.stopAnimation();
        pulse.setValue(1);

        Animated.timing(pulse, {
          toValue: 0,
          duration: 2200,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }).start(({ finished }) => {
          if (finished && !cancelled) setPulseIdxs([]);
          scheduleNext();
        });
      }, delayMs);
    };

    scheduleNext();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      setPulseIdxs([]);
      pulse.stopAnimation();
      pulse.setValue(0);
    };
  }, [sparkles.length, pulse]);

  const AnimatedPath = useMemo(() => Animated.createAnimatedComponent(Path), []);


  return (
    <View
      pointerEvents="none"
      style={[StyleSheet.absoluteFillObject, { backgroundColor: BG_BASE }]}
    >
      {/* Base (static): bg fill + vignette */}
      <Svg width={width} height={height}>
        <Defs>
          {/* Native can be picky with rgba() in stopColor, so use stopOpacity */}
          <RadialGradient id="bgVignette" cx="50%" cy="50%" r="65%">
            <Stop offset="0%" stopColor="rgb(0,0,0)" stopOpacity={0} />
            <Stop offset="70%" stopColor="rgb(0,0,0)" stopOpacity={0} />
            <Stop offset="100%" stopColor="rgb(0,0,0)" stopOpacity={VIGNETTE_OP} />
          </RadialGradient>
        </Defs>

        {/* Hard paint base first so native can't "forget" it */}
        <Rect x="0" y="0" width={width} height={height} fill={BG_BASE} />

        {/* Vignette */}
        <Rect x="0" y="0" width={width} height={height} fill="url(#bgVignette)" />
      </Svg>

      {/* Stars (animated): ultra-slow twinkle */}
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFillObject, { opacity: twinkleOpacity }]}
      >
        <Svg width={width} height={height}>
          {sparkles.map((sp, idx) => {
            const isPulse = pulseIdxs.includes(idx);
            const op = isPulse ? (Animated.multiply(pulseFactor, sp.op) as any) : sp.op;
            return (
              <AnimatedPath
              key={`bgsp-${idx}`}
              d={sparklePath(sp.x, sp.y, sp.si)}
              fill={SOFT_WHITE_SOLID}
              opacity={op}
              />
            );
          })}
        </Svg>
      </Animated.View>
    </View>
  );
});
// 

// SECTION 9) REAL TIME CARD

// SECTION 9.1) Component

function RealTimeCard({ textScale }: { textScale: number }) {
  const realStyles = useMemo(() => makeRealStyles(textScale), [textScale]);

  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const display = format12hTime(now.getHours(), now.getMinutes());

  return (
    <View style={{ alignItems: "center" }}>
      <Text style={realStyles.realLabel}>REAL TIME</Text>

      <View style={realStyles.realBox}>
        <Text style={realStyles.realBoxText}>{display}</Text>
      </View>
    </View>
  );
}


// SECTION 9.2) Styles


const makeRealStyles = (scale: number) => {
  const t = (n: number) => Math.round(n * scale);
  return StyleSheet.create({
  
  // Settings rows (Notifications toggle)
realLabel: {
    color: ACCENT,
    fontWeight: "900",
    fontSize: t(12),
    letterSpacing: t(2),
    textAlign: "center",
    marginBottom: 10,
    fontFamily: FONT_ROUNDED,
  },
  realBox: {
    width: 180,
    height: 56,
    borderRadius: 18,
    backgroundColor: PILL_BG,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
    justifyContent: "center",
    alignItems: "center",
  },
  realBoxText: {
    color: SOFT_WHITE,
    fontWeight: "900",
    fontSize: t(16),
    letterSpacing: t(1),
    fontFamily: FONT_ROUNDED,
  },
  });
};





// SECTION 10) CLOCK COMPONENT

// SECTION 10.1) Constants

const CLOCK_DIAM = 288;
const CANVAS_SIZE = 360;

// SECTION 10.2) PaliaClockFace

// SECTION 10.3) Props

function PaliaClockFace({
  paliaHour,
  paliaMinute,
  markers,
  nextTimeKey,
  rotateClock,
  starSeedSalt = 0,
}: {
  paliaHour: number;
  paliaMinute: number;
  markers: Marker[]; // enabled markers only
  nextTimeKey: string | null;
  rotateClock: boolean;
  starSeedSalt?: number;
}) {
// SECTION 10.4) Canvas + scale

  const SIZE = CANVAS_SIZE;
  const CX = SIZE / 2;
  const CY = SIZE / 2;

  const SCALE = CLOCK_DIAM / 320;
  const S = (n: number) => n * SCALE;

// SECTION 10.5) Radii + layout constants

  const BORDER_R = S(154);

  // Outer radius of the coloured ring (keeps the whole clock feeling the same size)
  const R_OUT_BASE = S(142);

  // DONUT VOID: this is the ONE knob for how big the empty center is.
  // Bigger number = bigger hole.
  const DONUT_VOID_R = S(70);

  // Ring thickness tuning (keeps your “fatter ring” look, without changing the void size)
  const RING_THICKNESS = R_OUT_BASE - DONUT_VOID_R;
  const RING_THICKNESS_PLUS = RING_THICKNESS * 1.1; // +10% thickness

  // Expand thickness OUTWARD only so DONUT_VOID_R stays exactly what you set.
  const R_OUT = R_OUT_BASE + (RING_THICKNESS_PLUS - RING_THICKNESS);
  const R_IN = DONUT_VOID_R;

  // Avoid RN-SVG hairline seams between arc wedges
  const ARC_EPS_DEG = 0.22;

  const EDGE_R = SIZE / 2 - 2;

  const MARKER_COL = "rgba(100, 93, 87, 1)";
  const MARKER_NEXT_COL = "rgba(255, 247, 231, 1)";

  // Marker diamond styling (active = NEXT slot)
  const MARKER_STROKE_ACTIVE = MARKER_COL;
  const MARKER_STROKE_INACTIVE = MARKER_NEXT_COL;
  const MARKER_STROKE_W = 0.6;

  /* =========================
     Outer ring knobs (edit-friendly)
     ========================= */
  // Position: + moves outward, - moves inward
  const OUTER_RING_OFFSET = S(-0);

  // Radius
  const OUTER_RING_R = BORDER_R + OUTER_RING_OFFSET;

  // Thickness
  const OUTER_RING_W = S(7);

  // Colours
  const OUTER_RING_STROKE = "rgba(100, 93, 87,1)";
  const OUTER_RING_FILL = "rgba(255,255,255,0)";

  // Marker position + length knobs
  const MARKER_TIP_OFFSET = S(-10);   // + moves marker outward, - inward (relative to OUTER_RING_R)
  const MARKER_LEN = S(20);         // diamond length (tail distance from tip)

  const MARKER_ARROW_TIP_R = OUTER_RING_R + MARKER_TIP_OFFSET;
  const MARKER_ARROW_BASE_R = Math.min(EDGE_R, MARKER_ARROW_TIP_R + MARKER_LEN);
  const MARKER_ARROW_SPREAD_DEG = 1.0 * 1.5;

  // Diamond shape knobs (main marker)
  const DIAMOND_SPREAD_MULT = 1.2; // width of the diamond (relative to spreadDeg)
  const SIDE_R_MIX = 0.65; // 0.1: where side points sit between tipR and baseR

  // Inner diamond overlay (2nd diamond on top of marker)
  const MARKER_INNER_CENTER_OFFSET = S(2); // + outward, - inward (relative to main marker centre)
  const MARKER_INNER_LEN_MULT = 0.25; // ~50% of main length (increase for longer inner diamond)
  const MARKER_INNER_WIDTH_MULT = 0.25; // ~50% of main width (increase for wider inner diamond)
  const MARKER_INNER_OP = 1;

  const FADE_MINS = 30;

  /* =========================
     Outer ring 2 (behind ring 1)
     ========================= */
  // Small radius bump so it peeks out behind the main ring
  const OUTER_RING2_GAP = S(-4);

  const OUTER_RING2_R = OUTER_RING_R + OUTER_RING2_GAP;
  const OUTER_RING2_W = Math.max(S(0), OUTER_RING_W * 0.5);

  const OUTER_RING2_STROKE = "rgba(255, 247, 231, 1)";
  const OUTER_RING2_FILL = "rgba(255,255,255,0)";

  // Icon colours (explicit RGBA refs)
  const SUN_COL = "rgba(254, 244, 230, 1)";
  const MOON_COL = "rgba(191, 197, 230, 1)";

  // Moon crescent "cut" colour: keep independent from ring palette for cross-platform consistency.
  const MOON_CUT_COL = "rgba(83, 92, 132, 1)";

  /* =========================
     Moon (baseline-style)
     - crescent "smile" + star
     - no backing badge
     ========================= */
  const MOON_LIGHT_R = S(18);
  const MOON_CUT_R = S(14.5);

  const MOON_CUT_OFF_X = S(0);
  const MOON_CUT_OFF_Y = S(8);

  const MOON_STAR_R = S(6);
  const MOON_STAR_OFF_X = S(0);
  const MOON_STAR_OFF_Y = S(11);

  /* =========================
     Sun (independent sizing)
     ========================= */
  const SUN_SCALE = 1.0;

  const SUN_BACK_OUT_D = S(100) * SUN_SCALE; // total diameter
  const SUN_BACK_IN_D = S(80) * SUN_SCALE; // inner void diameter
  const SUN_BACK_OUT_R = SUN_BACK_OUT_D / 2;
  const SUN_BACK_IN_R = SUN_BACK_IN_D / 2;

  const SUN_BACK_OP = 0.2;

  // Rings + body
  const SUN_RING1_R = S(30) * SUN_SCALE; // ring 1 (stroke only)
  const SUN_RING2_R = S(22) * SUN_SCALE; // ring 2 (stroke + faint fill)
  const SUN_BODY_R = S(18) * SUN_SCALE; // core body

  const SUN_RING_STROKE_OP = 0.4;
  const SUN_BODY_STROKE_OP = 0;

  // Feather controls (soft edge halo outside the core)
  const SUN_FEATHER_PAD = S(0) * SUN_SCALE;
  const SUN_FEATHER_OP = 0.3;

  // Base stroke thickness (you can still override per-line below)
  const SUN_STROKE_W = S(1.2) * SUN_SCALE;
  const SUN_BODY_STROKE_W = S(0) * SUN_SCALE;

  // Base ray reach beyond ring1 (used as the “default line half-length”)
  const SUN_RAY_PAD = S(0) * SUN_SCALE;

  /* =========================
     Sun line controls (edit-friendly)
     ========================= */

  // LINE 1: Horizontal (uses SUN_BACK_OUT_R)
  const SUN_LINE1_H_EXT = 1.1;
  const SUN_LINE1_OP = 0.3;
  const SUN_LINE1_W = SUN_STROKE_W;

  // LINE 2: Vertical (uses baseRayHalf)
  const SUN_LINE2_V_MULT = 1.00;
  const SUN_LINE2_OP = 0.3;
  const SUN_LINE2_W = SUN_STROKE_W;

  // LINE 3: Diagonal (\) (uses baseRayHalf)
  const SUN_LINE3_D1_MULT = 1.15;
  const SUN_LINE3_ANGLE_DEG = 30;
  const SUN_LINE3_OP = 0.3;
  const SUN_LINE3_W = SUN_STROKE_W;

  // LINE 4: Diagonal (/) (uses baseRayHalf)
  const SUN_LINE4_D2_MULT = 1.15;
  const SUN_LINE4_ANGLE_DEG = -30;
  const SUN_LINE4_OP = 0.3;
  const SUN_LINE4_W = SUN_STROKE_W;

  /* =========================
     Night wedge stars (ring-only)
     ========================= */
  const NIGHT_STARS_ON = true;

  // Count + spacing
  const NIGHT_STAR_COUNT = 22;
  const NIGHT_STAR_PAD_IN = S(12);  // keep stars away from inner void edge
  const NIGHT_STAR_PAD_OUT = S(12); // keep stars away from outer rim edge

  // Size + opacity (keep it subtle)
  const NIGHT_STAR_SIZE_MIN = S(0.9);
  const NIGHT_STAR_SIZE_MAX = S(2.2);

  const NIGHT_STAR_OP_MIN = 0.04;
  const NIGHT_STAR_OP_MAX = 0.16;
  const NIGHT_STAR_OP_CAP = 0.22;

  // Occasional slightly “brighter” star
  const NIGHT_STAR_BOOST_EVERY = 11;
  const NIGHT_STAR_BOOST_OP_MULT = 1.35;
  const NIGHT_STAR_BOOST_SIZE_MULT = 1.25;

  const NIGHT_STAR_COL = "rgba(245,250,255,1)";

// SECTION 10.6) Angle + polar helpers

  const minutesToAngle = (mins: number) => {
    const shifted = (mins - 12 * 60 + 1440) % 1440;
    return (shifted / 1440) * 360;
  };

  // Unwrapped version (can go below 0 or above 360). Use this for ranged-event arcs so
  // long intervals don't “flip” across the noon wrap caused by modulo math.
  const minutesToAngleUnwrapped = (mins: number) => ((mins - 12 * 60) / 1440) * 360;

  function polar(angleDeg: number, radius: number) {
    const rad = ((angleDeg - 90) * Math.PI) / 180;
    return { x: CX + Math.cos(rad) * radius, y: CY + Math.sin(rad) * radius };
  }

// SECTION 10.7) Path builders

  const donutSegmentPathR = (startAngle: number, endAngle: number, rOut: number, rIn: number) => {
    const sweep = endAngle - startAngle;
    const largeArc = sweep > 180 ? 1 : 0;

    const p1 = polar(startAngle, rOut);
    const p2 = polar(endAngle, rOut);
    const p3 = polar(endAngle, rIn);
    const p4 = polar(startAngle, rIn);

    return `
      M ${p1.x} ${p1.y}
      A ${rOut} ${rOut} 0 ${largeArc} 1 ${p2.x} ${p2.y}
      L ${p3.x} ${p3.y}
      A ${rIn} ${rIn} 0 ${largeArc} 0 ${p4.x} ${p4.y}
      Z
    `;
  };

  // IMPORTANT: apply a tiny overlap to kill RN-SVG seam lines between wedges.
  const donutSegmentPath = (startAngle: number, endAngle: number) =>
    donutSegmentPathR(startAngle - ARC_EPS_DEG, endAngle + ARC_EPS_DEG, R_OUT, R_IN);

  // Full donut ring (0–360) as a single path (two arcs). Useful for drawing glows as a donut.
  const donutRingPath = (rOut: number, rIn: number) => {
    const p1 = polar(0, rOut);
    const p2 = polar(180, rOut);
    const p3 = polar(360, rOut);

    const p4 = polar(360, rIn);
    const p5 = polar(180, rIn);
    const p6 = polar(0, rIn);

    return `
      M ${p1.x} ${p1.y}
      A ${rOut} ${rOut} 0 1 1 ${p2.x} ${p2.y}
      A ${rOut} ${rOut} 0 1 1 ${p3.x} ${p3.y}
      L ${p4.x} ${p4.y}
      A ${rIn} ${rIn} 0 1 0 ${p5.x} ${p5.y}
      A ${rIn} ${rIn} 0 1 0 ${p6.x} ${p6.y}
      Z
    `;
  };

  // Donut ring path centered at cx/cy (used for the sun outer ring)
  const donutRingPathAt = (cx: number, cy: number, rOut: number, rIn: number) => {
    return `
      M ${cx} ${cy - rOut}
      A ${rOut} ${rOut} 0 1 1 ${cx} ${cy + rOut}
      A ${rOut} ${rOut} 0 1 1 ${cx} ${cy - rOut}
      L ${cx} ${cy - rIn}
      A ${rIn} ${rIn} 0 1 0 ${cx} ${cy + rIn}
      A ${rIn} ${rIn} 0 1 0 ${cx} ${cy - rIn}
      Z
    `;
  };

  // Diamond marker path (decorative, closer to in-game clock).
  const diamondMarkerPath = (
    angleDeg: number,
    tipR: number,
    baseR: number,
    spreadDeg: number,
    spreadMult: number,
    sideMix: number
  ) => {
    const sideA = spreadDeg * spreadMult;
    const sideR = tipR + (baseR - tipR) * sideMix;

    // tip is the inner point (toward centre), tail is the outer point
    const tip = polar(angleDeg, tipR);
    const left = polar(angleDeg - sideA, sideR);
    const tail = polar(angleDeg, baseR);
    const right = polar(angleDeg + sideA, sideR);

    return `M ${tip.x} ${tip.y} L ${left.x} ${left.y} L ${tail.x} ${tail.y} L ${right.x} ${right.y} Z`;
  };

  // Main marker diamond (uses your marker radii + global diamond knobs)
  const boundaryArrowPath = (angleDeg: number, baseR: number, spreadDeg: number) =>
    diamondMarkerPath(angleDeg, MARKER_ARROW_TIP_R, baseR, spreadDeg, DIAMOND_SPREAD_MULT, SIDE_R_MIX);

  // Convenience wrapper for default settings
  const markerArrowPath = (angleDeg: number) =>
    boundaryArrowPath(angleDeg, MARKER_ARROW_BASE_R, MARKER_ARROW_SPREAD_DEG);

  // Inner marker diamond (overlay)
  const markerInnerPath = (angleDeg: number) => {
    // Build a smaller diamond centred within the main marker (with a tweakable offset)
    const mainMidR = (MARKER_ARROW_TIP_R + MARKER_ARROW_BASE_R) / 2;
    const midR = mainMidR + MARKER_INNER_CENTER_OFFSET;

    const innerLen = MARKER_LEN * MARKER_INNER_LEN_MULT;
    const tipR = midR - innerLen / 2;
    const baseR = Math.min(EDGE_R, midR + innerLen / 2);

    const spreadMult = DIAMOND_SPREAD_MULT * MARKER_INNER_WIDTH_MULT;

    return diamondMarkerPath(angleDeg, tipR, baseR, MARKER_ARROW_SPREAD_DEG, spreadMult, SIDE_R_MIX);
  };

  // Keep your render API stable (your render uses arcWedgePath)
  const arcWedgePath = (startDeg: number, endDeg: number, rOut: number, rIn: number) =>
    donutSegmentPathR(startDeg, endDeg, rOut, rIn);


// Stroke-only arc path (used for range overlays along the inner ring edge)
const arcStrokePath = (startDeg: number, endDeg: number, r: number) => {
  const sweep = endDeg - startDeg;
  const largeArc = sweep > 180 ? 1 : 0;

  const p1 = polar(startDeg, r);
  const p2 = polar(endDeg, r);

  return `M ${p1.x} ${p1.y} A ${r} ${r} 0 ${largeArc} 1 ${p2.x} ${p2.y}`;
};

  // Rounded rect path (used for the center pill)
  const roundedRectPath = (x: number, y: number, w: number, h: number, r: number) => {
    const rr = Math.min(r, w / 2, h / 2);
    return `
      M ${x + rr} ${y}
      H ${x + w - rr}
      A ${rr} ${rr} 0 0 1 ${x + w} ${y + rr}
      V ${y + h - rr}
      A ${rr} ${rr} 0 0 1 ${x + w - rr} ${y + h}
      H ${x + rr}
      A ${rr} ${rr} 0 0 1 ${x} ${y + h - rr}
      V ${y + rr}
      A ${rr} ${rr} 0 0 1 ${x + rr} ${y}
      Z
    `;
  };

// SECTION 10.8) Random + sparkle paths

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

// SECTION 10.9) Sparkles layout

  const sparkles = useMemo(() => {
    const SPARKLE_COUNT = 54;
    const SPARKLE_R_MIN = R_IN + S(10);
    const SPARKLE_R_MAX = BORDER_R - S(10);

    return Array.from({ length: SPARKLE_COUNT }, (_, i) => {
      const a = rand01(i + 10) * 360;
      const rr = SPARKLE_R_MIN + rand01(i + 200) * (SPARKLE_R_MAX - SPARKLE_R_MIN);
      const p = polar(a, rr);

      let size = (S(1.0) + rand01(i + 400) * S(1.2)) * 1.05;
      if (i % 11 === 0) size *= 1.6;

      let op = (0.05 + rand01(i + 700) * 0.10) * 1.75 * (Math.random() < 0.002 ? 1.35 : 1);
      if (i % 11 === 0) op += 0.04;
      op = Math.min(0.40, op);

      return { x: p.x, y: p.y, size, op };
    });
  }, [R_IN, BORDER_R]);

// SECTION 10.10) Segment palette

  const COL = {
    morning: "rgba(213, 181, 142, 1)",
    day: "rgba(137, 186, 235, 1)",
    evening: "rgba(220, 160, 167, 1)",
    night: "rgba(83, 92, 132, 1)",
  };

// SECTION 10.11) Time-of-day segments

  const mins = (h: number, m: number) => h * 60 + m;
  const T03 = mins(3, 0);
  const T06 = mins(6, 0);
  const T18 = mins(18, 0);
  const T21 = mins(21, 0);

  const seg = (startMin: number, endMin: number) => {
    const a1 = minutesToAngle(startMin);
    const a2 = minutesToAngle(endMin);
    return a2 >= a1 ? [a1, a2] : [a1, a2 + 360];
  };

  const ringSegments = [
    { key: "day", color: COL.day, range: seg(T06, T18), opacity: 1 },
    { key: "evening", color: COL.evening, range: seg(T18, T21), opacity: 1 },
    { key: "night", color: COL.night, range: seg(T21, T03), opacity: 1 },
    { key: "morning", color: COL.morning, range: seg(T03, T06), opacity: 1 },
  ];

// SECTION 10.12) Segment boundary fades (true blend band)

  const fades = (() => {
    const wrap = (m: number) => ((m % 1440) + 1440) % 1440;

    const rangeA = (m1: number, m2: number) => {
      const a1 = minutesToAngle(wrap(m1));
      const a2raw = minutesToAngle(wrap(m2));
      const a2 = a2raw >= a1 ? a2raw : a2raw + 360;
      return { a1, a2 };
    };

    const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

    // Smooth easing so the blend lingers near each segment colour (avoids a harsh “mid band”)
    const ease01 = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(t));

    const parseColor = (c: string) => {
      // rgba(...) or rgb(...)
      let m = c.match(
        /rgba?\s*\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+))?\s*\)/i
      );
      if (m) {
        return {
          r: Number(m[1]),
          g: Number(m[2]),
          b: Number(m[3]),
          a: m[4] == null ? 1 : Number(m[4]),
        };
      }

      // #RRGGBB or #RRGGBBAA
      m = c.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
      if (m) {
        const hex = m[1];
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        const a = m[2] ? parseInt(m[2], 16) / 255 : 1;
        return { r, g, b, a };
      }

      // Fallback
      return { r: 255, g: 255, b: 255, a: 1 };
    };

    const toRgba = (r: number, g: number, b: number, a: number) =>
      `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`;

    const applyOpacityIntoAlpha = (color: string, opacity: number) => {
      const p = parseColor(color);
      return toRgba(p.r, p.g, p.b, p.a * opacity);
    };

    const mixColor = (c1: string, c2: string, t: number) => {
      const a = parseColor(c1);
      const b = parseColor(c2);
      const tt = clamp01(t);
      return toRgba(lerp(a.r, b.r, tt), lerp(a.g, b.g, tt), lerp(a.b, b.b, tt), lerp(a.a, b.a, tt));
    };

    // Get the *effective* segment colour (opacity baked into alpha)
    const segEffective = (key: string, fallback: string) => {
      const seg = ringSegments.find((s) => s.key === key);
      if (!seg) return fallback;
      return applyOpacityIntoAlpha(seg.color, seg.opacity ?? 1);
    };

    // Controls
    const FADE_SPAN = Math.max(FADE_MINS, Math.round(FADE_MINS * 1.8)); // wider blend band
    const FADE_STEPS = 44; // smoother gradient

    const out: { a1: number; a2: number; color: string; opacity: number }[] = [];

    const addBoundary = (
      atMin: number,
      prevKey: string,
      nextKey: string,
      prevFallback: string,
      nextFallback: string
    ) => {
      const prev = segEffective(prevKey, prevFallback);
      const next = segEffective(nextKey, nextFallback);

      for (let i = 0; i < FADE_STEPS; i++) {
        const t0 = i / FADE_STEPS;
        const t1 = (i + 1) / FADE_STEPS;

        const m1 = atMin - FADE_SPAN + (FADE_SPAN * 2) * t0;
        const m2 = atMin - FADE_SPAN + (FADE_SPAN * 2) * t1;

        const { a1, a2 } = rangeA(m1, m2);
        const tMid = ease01((t0 + t1) / 2);

        out.push({
          a1: a1 - ARC_EPS_DEG,
          a2: a2 + ARC_EPS_DEG,
          color: mixColor(prev, next, tMid),
          opacity: 1, // fully replace wedges in the blend band
        });
      }
    };

    // Boundaries: 06:00, 18:00, 21:00, 03:00
    addBoundary(T06, "morning", "day", COL.morning, COL.day);
    addBoundary(T18, "day", "evening", COL.day, COL.evening);
    addBoundary(T21, "evening", "night", COL.evening, COL.night);
    addBoundary(T03, "night", "morning", COL.night, COL.morning);

    return out;
  })();

// SECTION 10.13) Rotation + derived positions

  const totalMinutes = paliaHour * 60 + paliaMinute;
  const handAngle = minutesToAngle(totalMinutes);

  const faceRot = rotateClock ? -handAngle : 0;
  const handAngleDraw = rotateClock ? 0 : handAngle;

  const HAND_W = S(6);

  // Hand constrained to the coloured ring only (donut band):
  // Use pads so the rounded caps don't bleed into the void or outside the ring.
  const HAND_PAD_IN = S(4);
  const HAND_PAD_OUT = S(6);

  const HAND_IN_R = R_IN + HAND_W / 2 + HAND_PAD_IN;
  const HAND_OUT_R = R_OUT - HAND_W / 2 - HAND_PAD_OUT;

  const handP1 = polar(handAngleDraw, HAND_IN_R);
  const handP2 = polar(handAngleDraw, HAND_OUT_R);

  const markerArrows = markers.map((m) => {
    const mm = m.hour * 60 + m.minute;
    const a = minutesToAngle(mm);
    return { ...m, angle: a };
  });

  /* =========================
     Night-only ring stars (subtle)
     - generated ONLY within the night wedge angles and ring band radii
     - rotates naturally with the clock because it’s drawn inside the rotating <G>
     ========================= */
  const NIGHT_A0 = minutesToAngle(21 * 60);
  const NIGHT_A1_RAW = minutesToAngle(3 * 60);
  const NIGHT_A1 = NIGHT_A1_RAW >= NIGHT_A0 ? NIGHT_A1_RAW : NIGHT_A1_RAW + 360;

  const nightStars = useMemo(() => {
    if (!NIGHT_STARS_ON) return [];
    const span = Math.max(0.0001, NIGHT_A1 - NIGHT_A0);

    const rMin = R_IN + NIGHT_STAR_PAD_IN;
    const rMax = R_OUT - NIGHT_STAR_PAD_OUT;

    return Array.from({ length: NIGHT_STAR_COUNT }, (_, i) => {
      const a = NIGHT_A0 + rand01(i + 9100) * span;
      const rr = rMin + rand01(i + 9200) * (rMax - rMin);
      const p = polar(a, rr);

      let size = NIGHT_STAR_SIZE_MIN + rand01(i + 9300) * (NIGHT_STAR_SIZE_MAX - NIGHT_STAR_SIZE_MIN);
      if (NIGHT_STAR_BOOST_EVERY > 0 && i % NIGHT_STAR_BOOST_EVERY === 0) size *= NIGHT_STAR_BOOST_SIZE_MULT;

      let op = NIGHT_STAR_OP_MIN + rand01(i + 9400) * (NIGHT_STAR_OP_MAX - NIGHT_STAR_OP_MIN);
      if (NIGHT_STAR_BOOST_EVERY > 0 && i % NIGHT_STAR_BOOST_EVERY === 0) op *= NIGHT_STAR_BOOST_OP_MULT;
      op = Math.min(NIGHT_STAR_OP_CAP, op);

      return { x: p.x, y: p.y, size, op };
    });
  }, [R_IN, R_OUT, NIGHT_A0, NIGHT_A1]);

  // Time-of-day icon positions (sun/moon)
  const ICON_R = S(107);
  const sunPos = polar(minutesToAngle(12 * 60), ICON_R);
  const moonPos = polar(minutesToAngle(0), ICON_R);

  // Center digital label
  const formattedPaliaTime = format12hTime(paliaHour, paliaMinute);

  // Center display pill geometry (path only; styling is in render)
  // Circular time badge sized to sit inside the innermost (3rd) range lane.
  // (We keep the knob math local so you can move lanes around without
  // the time badge suddenly poking through them.)
  const RANGE_ARC_BASE_R_FOR_PILL = R_IN + S(-4);
  const RANGE_ARC_W_FOR_PILL = S(4.0);
  const RANGE_ARC_LANE_GAP_FOR_PILL = RANGE_ARC_W_FOR_PILL + S(2);
  const INNERMOST_LANE_R_FOR_PILL = RANGE_ARC_BASE_R_FOR_PILL - 2 * RANGE_ARC_LANE_GAP_FOR_PILL;

  // Keep a little breathing room so the badge never touches lane 3.
  const DISPLAY_R = Math.max(S(22), INNERMOST_LANE_R_FOR_PILL - S(6));

  const DISPLAY_W = DISPLAY_R * 2;
  const DISPLAY_H = DISPLAY_R * 2;
  const DISPLAY_RX = DISPLAY_R; // roundedRectPath with rx==r => perfect circle
  const displayX = CX - DISPLAY_W / 2;
  const displayY = CY - DISPLAY_H / 2;

  const displayPillPath = useMemo(
    () => roundedRectPath(displayX, displayY, DISPLAY_W, DISPLAY_H, DISPLAY_RX),
    [displayX, displayY, DISPLAY_W, DISPLAY_H, DISPLAY_RX]
  );

  // Build paint wedges for the ring (base segments first, then fade overlays last)
  const wedges = useMemo(() => {
    const base = ringSegments.map((s) => ({
      key: `seg:${s.key}`,
      a0: s.range[0],
      a1: s.range[1],
      fill: s.color,
      opacity: s.opacity ?? 1,
    }));

    const blend = fades.map((f, i) => ({
      key: `fade:${i}`,
      a0: f.a1,
      a1: f.a2,
      fill: f.color,
      opacity: f.opacity ?? 1,
    }));

    return [...base, ...blend];
  }, [ringSegments, fades]);


// SECTION 10.13) Range arcs (inner edge overlay)
// Draw enabled ranged events as thin rounded arcs where the ring meets the void.
// Inactive = soft white @ 0.40. Active (currently happening) = gold @ 0.95 + subtle glow.
//
// Lanes: if ranged events overlap in time, we render them as separate "lanes" that step
// inward into the void (so overlaps don't sit on top of each other).
const RANGE_ARC_BASE_R = R_IN + S(-4); // base radius (closer to the void edge)
const RANGE_ARC_W = S(4.0);
const RANGE_ARC_LANE_GAP = RANGE_ARC_W + S(2); // how far each overlap lane steps inward
const RANGE_ARC_W_GLOW = S(6);
const RANGE_ARC_EPS = 0.35; // tiny overlap to avoid hairline gaps

type RangeArc = { key: string; d: string; active: boolean };

const rangeArcs = useMemo<RangeArc[]>(() => {
  if (!markers?.length) return [];

  const toMin = (h: number, m: number) => h * 60 + m;

  const isActiveRange = (
    sh: number,
    sm: number,
    eh: number,
    em: number,
    nowH: number,
    nowM: number
  ) => {
    const start = toMin(sh, sm);
    const end = toMin(eh, em);
    const now = toMin(nowH, nowM);

    // Treat equal start/end as "no duration" (shouldn't happen, but humans are creative).
    if (start === end) return false;

    // Non-wrapping
    if (end > start) return now >= start && now < end;

    // Wrap past midnight
    return now >= start || now < end;
  };

  type Seg = { s: number; e: number };
  type RangedEvent = {
    id: string;
    sh: number;
    sm: number;
    eh: number;
    em: number;
    segs: Seg[];
    active: boolean;
    lane?: number;
    sortKey: number;
    durationMins: number;
  };

  const ranged: RangedEvent[] = [];
  const DAY_MINS = 24 * 60;

  for (const m of markers) {
    const hasRange =
      !!m.hasRange &&
      typeof m.endHour === "number" &&
      typeof m.endMinute === "number" &&
      !!m.enabled; // only draw overlays for enabled events

    if (!hasRange) continue;

    const sh = m.hour;
    const sm = m.minute;
    const eh = m.endHour as number;
    const em = m.endMinute as number;

    const start = toMin(sh, sm);
    const end = toMin(eh, em);

    const segs: Seg[] =
      end > start
        ? [{ s: start, e: end }]
        : [
            { s: start, e: DAY_MINS },
            { s: 0, e: end },
          ];

    const durationMins =
      end > start ? end - start : (DAY_MINS - start) + end;

    ranged.push({
      id: m.id,
      sh,
      sm,
      eh,
      em,
      segs,
      active: isActiveRange(sh, sm, eh, em, paliaHour, paliaMinute),
      sortKey: start,
      durationMins,
    });
  }

  if (!ranged.length) return [];

  const segOverlaps = (a: Seg, b: Seg) => Math.max(a.s, b.s) < Math.min(a.e, b.e);

  const eventOverlaps = (a: RangedEvent, b: RangedEvent) => {
    for (const sa of a.segs) {
      for (const sb of b.segs) {
        if (segOverlaps(sa, sb)) return true;
      }
    }
    return false;
  };

  // We want *longer* ranges to sit closer to the ring (outside), and shorter ones to
  // step further into the void. So: place longer durations first (lower lane index).
  //
  // Within the same duration, keep the earlier start first so it feels stable.
  ranged.sort((a, b) => (b.durationMins - a.durationMins) || (a.sortKey - b.sortKey));

  const MAX_LANES = 3;

  // Greedy lane assignment with a hard cap:
  // - Try to place into any existing lane without overlaps
  // - If we still have lane budget, create a new lane
  // - Otherwise, shove into the last lane (accepting overlaps)
  const lanes: RangedEvent[][] = [];

  for (const ev of ranged) {
    let placed = false;

    for (let li = 0; li < lanes.length; li++) {
      const laneEvents = lanes[li];
      const conflict = laneEvents.some((other) => eventOverlaps(ev, other));
      if (!conflict) {
        ev.lane = li;
        laneEvents.push(ev);
        placed = true;
        break;
      }
    }

    if (!placed) {
      if (lanes.length < MAX_LANES) {
        ev.lane = lanes.length;
        lanes.push([ev]);
      } else {
        // Lane cap hit. Pile it into the last lane.
        ev.lane = MAX_LANES - 1;
        lanes[MAX_LANES - 1].push(ev);
      }
    }
  }

  const out: RangeArc[] = [];

  for (const ev of ranged) {
    const lane = Math.max(0, Math.min(MAX_LANES - 1, ev.lane ?? 0));
    const r = RANGE_ARC_BASE_R - lane * RANGE_ARC_LANE_GAP;

    for (let si = 0; si < ev.segs.length; si++) {
      const seg = ev.segs[si];
      const a0 = minutesToAngleUnwrapped(seg.s);
      const a1 = minutesToAngleUnwrapped(seg.e);

      // Avoid the "double hit" at 00:00 when a range wraps:
      // - Don't extend past 24:00 on the last segment
      // - Don't extend before 00:00 on the first segment
      const epsL = seg.s === 0 ? 0 : RANGE_ARC_EPS;
      const epsR = seg.e === DAY_MINS ? 0 : RANGE_ARC_EPS;

      const d = arcStrokePath(a0 - epsL, a1 + epsR, r);
      out.push({ key: `rng:${ev.id}:l${lane}:s${si}`, d, active: ev.active });
    }
  }

  return out;
}, [markers, paliaHour, paliaMinute, RANGE_ARC_BASE_R, RANGE_ARC_LANE_GAP]);


  // Ticks (24 total; major every 3 hours)
  type Tick = {
    key: string;
    p1: { x: number; y: number };
    p2: { x: number; y: number };
    isMajor: boolean;
  };

  const ticks: Tick[] = useMemo(() => {
    const out: Tick[] = [];

    // 24-hour dial so you get the full set of ticks back
    for (let h = 0; h < 24; h++) {
      const a = minutesToAngle(h * 60);
      const p1 = polar(a, R_OUT - S(12));
      const p2 = polar(a, R_OUT - S(6));
      out.push({ key: `t${h}`, p1, p2, isMajor: h % 3 === 0 });
    }

    return out;
  }, [R_OUT, SCALE]);

// SECTION 10.14) Next marker “signature stars”

  const hashStr = (s: string) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  };

  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

  const NEXT_STAR_MARGIN = S(10);

  // Core (fixed) stars
  const NEXT_STAR_R1 = Math.min(EDGE_R - NEXT_STAR_MARGIN, MARKER_ARROW_BASE_R + S(6));
  const NEXT_STAR_R2 = Math.min(EDGE_R - NEXT_STAR_MARGIN, MARKER_ARROW_BASE_R + S(12));
  const NEXT_STAR_OFF_DEG = 5.5;

  const NEXT_STAR_SIZE = S(2.1);
  const NEXT_STAR_SIZE_BIG = S(2.8);

  // Extra (random) stars: 3 of them, kept near the core stars
  const EXTRA_STAR_SIZE_1 = S(1.8);
  const EXTRA_STAR_SIZE_2 = S(1.6);
  const EXTRA_STAR_SIZE_3 = S(1.5);

  const EXTRA_GAP_MIN = Math.min(EDGE_R - NEXT_STAR_MARGIN, MARKER_ARROW_BASE_R + S(2.2));
  const EXTRA_GAP_MAX = Math.min(EDGE_R - NEXT_STAR_MARGIN, NEXT_STAR_R2 - S(2.4));

  // Push extras closer to the main stars so they actually "join" them.
  const EXTRA_R_TARGET = clamp(MARKER_ARROW_BASE_R + S(8.0), EXTRA_GAP_MIN, EXTRA_GAP_MAX);
  const EXTRA_R_JITTER = S(2.2);

  const EXTRA_SHOULDER_OFF_DEG = NEXT_STAR_OFF_DEG + 2.8;
  const EXTRA_A_JITTER = 2.6;
  const EXTRA_MID_JITTER_DEG = 4.2;

  type NextStar = { id: string; x: number; y: number; r: number; kind: "core" | "extra" };

  const getNextMarkerStars = (angleDeg: number, seedKey: string) => {
    // --- Core (fixed) ---
    const p1 = polar(angleDeg - NEXT_STAR_OFF_DEG, NEXT_STAR_R1);
    const p2 = polar(angleDeg + NEXT_STAR_OFF_DEG, NEXT_STAR_R1);
    const p3 = polar(angleDeg, NEXT_STAR_R2);

    // --- Extra (random) ---
    const seed = hashStr(seedKey);

    // Shoulder left
    const a4 = angleDeg - EXTRA_SHOULDER_OFF_DEG + (rand01(seed + 101) - 0.5) * 2 * EXTRA_A_JITTER;
    let r4 = EXTRA_R_TARGET + (rand01(seed + 102) - 0.5) * 2 * EXTRA_R_JITTER;
    r4 = clamp(r4, EXTRA_GAP_MIN, EXTRA_GAP_MAX);
    const p4 = polar(a4, r4);

    // Shoulder right
    const a5 = angleDeg + EXTRA_SHOULDER_OFF_DEG + (rand01(seed + 201) - 0.5) * 2 * EXTRA_A_JITTER;
    let r5 = EXTRA_R_TARGET + (rand01(seed + 202) - 0.5) * 2 * EXTRA_R_JITTER;
    r5 = clamp(r5, EXTRA_GAP_MIN, EXTRA_GAP_MAX);
    const p5 = polar(a5, r5);

    // Middle-ish (random scatter near the arrow axis)
    const a6 = angleDeg + (rand01(seed + 301) - 0.5) * 2 * EXTRA_MID_JITTER_DEG;
    let r6 = (EXTRA_R_TARGET + NEXT_STAR_R1) / 2 + (rand01(seed + 302) - 0.5) * 2 * EXTRA_R_JITTER;
    r6 = clamp(r6, EXTRA_GAP_MIN, EXTRA_GAP_MAX);
    const p6 = polar(a6, r6);

    const stars: NextStar[] = [
      // core 3
      { id: "l", x: p1.x, y: p1.y, r: NEXT_STAR_SIZE, kind: "core" },
      { id: "r", x: p2.x, y: p2.y, r: NEXT_STAR_SIZE, kind: "core" },
      { id: "t", x: p3.x, y: p3.y, r: NEXT_STAR_SIZE_BIG, kind: "core" },

      // random 3
      { id: "e1", x: p4.x, y: p4.y, r: EXTRA_STAR_SIZE_1, kind: "extra" },
      { id: "e2", x: p5.x, y: p5.y, r: EXTRA_STAR_SIZE_2, kind: "extra" },
      { id: "e3", x: p6.x, y: p6.y, r: EXTRA_STAR_SIZE_3, kind: "extra" },
    ];

    return stars;
  };

// SECTION 10.15) Next marker stars (ONLY the active/next time slot)

  const nextSlotAngle = useMemo(() => {
    if (!nextTimeKey) return null;
    const mk = markerArrows.find((m) => `${pad2(m.hour)}:${pad2(m.minute)}` === nextTimeKey);
    return mk ? mk.angle : null;
  }, [markerArrows, nextTimeKey]);

  const nextStarGroup = useMemo(() => {
    if (!nextTimeKey || nextSlotAngle == null) return null;

    const core = getNextMarkerStars(nextSlotAngle, `${nextTimeKey}:core`).filter((s) => s.kind === "core");
    const extra = getNextMarkerStars(
      nextSlotAngle,
      `${nextTimeKey}:extra:${starSeedSalt ?? 0}`
    ).filter((s) => s.kind === "extra");

    return { core, extra };
  }, [nextTimeKey, nextSlotAngle, starSeedSalt]);

// SECTION 10.16) Render

  return (
    <View style={clockStyles.wrap}>
      <View style={clockStyles.canvas}>
        <Svg width={CANVAS_SIZE} height={CANVAS_SIZE} viewBox={`0 0 ${CANVAS_SIZE} ${CANVAS_SIZE}`}>
          <Defs>
            {/* NOTE: Android-native svg often ignores alpha in stopColor rgba().
                Use stopOpacity for consistent rendering across web + native. */}

            {/* Clip the ring area (donut) so sun backing never bleeds into the center void */}
            <ClipPath id="ringClip" {...({ clipPathUnits: "userSpaceOnUse" } as any)}>
              <Path d={donutRingPath(R_OUT, R_IN)} />
            </ClipPath>

            <RadialGradient id="ringGlow" cx="50%" cy="35%" r="65%">
              <Stop offset="0%" stopColor="rgb(255,255,255)" stopOpacity={0} />
              <Stop offset="55%" stopColor="rgb(255,255,255)" stopOpacity={0} />
              <Stop offset="100%" stopColor="rgb(180,200,255)" stopOpacity={0} />
            </RadialGradient>

            <LinearGradient id="innerShade" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0%" stopColor="rgb(8,10,12)" stopOpacity={0} />
              <Stop offset="55%" stopColor="rgb(8,10,12)" stopOpacity={0} />
              <Stop offset="100%" stopColor="rgb(8,10,12)" stopOpacity={0} />
            </LinearGradient>

            <LinearGradient id="voidShade" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0%" stopColor="rgb(0,0,0)" stopOpacity={0} />
              <Stop offset="60%" stopColor="rgb(0,0,0)" stopOpacity={0} />
              <Stop offset="100%" stopColor="rgb(0,0,0)" stopOpacity={0} />
            </LinearGradient>

            <RadialGradient id="sunCore" cx="50%" cy="50%" r="55%">
              <Stop offset="0%" stopColor="rgb(255,255,255)" stopOpacity={1} />
              <Stop offset="75%" stopColor="rgb(254,244,230)" stopOpacity={1} />
              <Stop offset="100%" stopColor="rgb(254,244,230)" stopOpacity={0} />
            </RadialGradient>

            <RadialGradient id="sunFeather" cx="50%" cy="50%" r="65%">
              <Stop offset="0%" stopColor="rgb(254,244,230)" stopOpacity={1} />
              <Stop offset="70%" stopColor="rgb(254,244,230)" stopOpacity={SUN_FEATHER_OP * 0.5} />
              <Stop offset="100%" stopColor="rgb(254,244,230)" stopOpacity={SUN_FEATHER_OP} />
            </RadialGradient>
          </Defs>

          <G rotation={rotateClock ? faceRot : 0} originX={CX} originY={CY}>
            {/* base ring */}
            <Circle cx={CX} cy={CY} r={R_OUT} fill="url(#ringGlow)" opacity={0.30} />
            <Circle cx={CX} cy={CY} r={R_OUT} fill="rgba(255,255,255,0.012)" opacity={1} />
            <Circle cx={CX} cy={CY} r={R_IN} fill="url(#voidShade)" opacity={1} />


{/* ring wedges */}
{wedges.map((w) => (
  <Path key={w.key} d={arcWedgePath(w.a0, w.a1, R_IN, R_OUT)} fill={w.fill} opacity={1} />
))}

{/* range arcs along the inner edge (ranged events) */}
{rangeArcs.map((a) => (
  <G key={a.key}>
    {a.active ? (
      <Path
        d={a.d}
        stroke={`rgb(${ACCENT_RGB})`}
        strokeWidth={RANGE_ARC_W_GLOW}
        opacity={0.10}
        strokeLinecap="round"
        fill="none"
      />
    ) : null}
    <Path
      d={a.d}
      stroke={a.active ? `rgb(${ACCENT_RGB})` : "rgb(252,248,240)"}
      strokeWidth={RANGE_ARC_W}
      opacity={a.active ? 0.95 : 0.4}
      strokeLinecap="round"
      fill="none"
    />
  </G>
))}

{/* inner shade */}
            <Circle cx={CX} cy={CY} r={R_IN} fill="url(#innerShade)" opacity={1} />

            {/* Night wedge stars (ONLY the night section) */}
            {NIGHT_STARS_ON
              ? nightStars.map((sp, idx) => (
                  <Path
                    key={`nightsp-${idx}`}
                    d={sparklePath(sp.x, sp.y, sp.size)}
                    fill={NIGHT_STAR_COL}
                    opacity={sp.op}
                  />
                ))
              : null}

            {/* ticks */}
            {ticks.map((t: Tick) => (
              <Line
                key={t.key}
                x1={t.p1.x}
                y1={t.p1.y}
                x2={t.p2.x}
                y2={t.p2.y}
                stroke="rgba(245,250,255,1)"
                strokeWidth={t.isMajor ? S(2.2) : S(1.2)}
                opacity={t.isMajor ? 0.28 : 0.16}
                strokeLinecap="round"
              />
            ))}

            {/* Time-of-day icons (sun/moon) */}

            {/* Clip JUST the sun group to the donut ring so its backing never shows in the void */}
            <G clipPath="url(#ringClip)">
              <G opacity={1}>
                <Circle cx={sunPos.x} cy={sunPos.y} r={SUN_BACK_OUT_R} fill={SUN_COL} opacity={SUN_BACK_OP} />
                <Circle cx={sunPos.x} cy={sunPos.y} r={SUN_BACK_IN_R} fill="rgba(0,0,0,0)" />

                <Line
                  x1={sunPos.x - SUN_BACK_OUT_R * SUN_LINE1_H_EXT}
                  y1={sunPos.y}
                  x2={sunPos.x + SUN_BACK_OUT_R * SUN_LINE1_H_EXT}
                  y2={sunPos.y}
                  stroke={SUN_COL}
                  strokeWidth={SUN_LINE1_W}
                  strokeOpacity={SUN_LINE1_OP}
                  strokeLinecap="round"
                />

                <Circle
                  cx={sunPos.x}
                  cy={sunPos.y}
                  r={SUN_RING1_R}
                  stroke={SUN_COL}
                  strokeWidth={SUN_STROKE_W}
                  strokeOpacity={SUN_RING_STROKE_OP}
                  fill="rgba(0,0,0,0)"
                />

                <Circle
                  cx={sunPos.x}
                  cy={sunPos.y}
                  r={SUN_RING2_R}
                  stroke={SUN_COL}
                  strokeWidth={SUN_STROKE_W}
                  strokeOpacity={SUN_RING_STROKE_OP}
                  fill={SUN_COL}
                  fillOpacity={0.2}
                />

                <Circle
                  cx={sunPos.x}
                  cy={sunPos.y}
                  r={SUN_BODY_R + SUN_FEATHER_PAD}
                  fill="url(#sunFeather)"
                  opacity={1}
                />

                <Circle
                  cx={sunPos.x}
                  cy={sunPos.y}
                  r={SUN_BODY_R}
                  fill="url(#sunCore)"
                  stroke={SUN_COL}
                  strokeWidth={SUN_BODY_STROKE_W}
                  strokeOpacity={SUN_BODY_STROKE_OP}
                />

                {(() => {
                  const baseRayHalf = SUN_RING1_R + SUN_RAY_PAD;

                  const line2Half = baseRayHalf * SUN_LINE2_V_MULT;
                  const line3Half = baseRayHalf * SUN_LINE3_D1_MULT;
                  const line4Half = baseRayHalf * SUN_LINE4_D2_MULT;

                  // Angle knobs (degrees -> radians)
                  const th3 = (SUN_LINE3_ANGLE_DEG * Math.PI) / 180;
                  const th4 = (SUN_LINE4_ANGLE_DEG * Math.PI) / 180;

                  const dx3 = Math.cos(th3) * line3Half;
                  const dy3 = Math.sin(th3) * line3Half;

                  const dx4 = Math.cos(th4) * line4Half;
                  const dy4 = Math.sin(th4) * line4Half;

                  return (
                    <>
                      <Line
                        x1={sunPos.x}
                        y1={sunPos.y - line2Half}
                        x2={sunPos.x}
                        y2={sunPos.y + line2Half}
                        stroke={SUN_COL}
                        strokeWidth={SUN_LINE2_W}
                        strokeOpacity={SUN_LINE2_OP}
                        strokeLinecap="round"
                      />

                      {/* Diagonal (\) */}
                      <Line
                        x1={sunPos.x - dx3}
                        y1={sunPos.y - dy3}
                        x2={sunPos.x + dx3}
                        y2={sunPos.y + dy3}
                        stroke={SUN_COL}
                        strokeWidth={SUN_LINE3_W}
                        strokeOpacity={SUN_LINE3_OP}
                        strokeLinecap="round"
                      />

                      {/* Diagonal (/) */}
                      <Line
                        x1={sunPos.x - dx4}
                        y1={sunPos.y - dy4}
                        x2={sunPos.x + dx4}
                        y2={sunPos.y + dy4}
                        stroke={SUN_COL}
                        strokeWidth={SUN_LINE4_W}
                        strokeOpacity={SUN_LINE4_OP}
                        strokeLinecap="round"
                      />
                    </>
                  );
                })()}
              </G>
            </G>

            {/* Moon (force fully opaque) */}
            <G opacity={1}>
              <Circle cx={moonPos.x} cy={moonPos.y} r={MOON_LIGHT_R} fill={MOON_COL} opacity={1} fillOpacity={1} />
              <Circle
                cx={moonPos.x + MOON_CUT_OFF_X}
                cy={moonPos.y - MOON_CUT_OFF_Y}
                r={MOON_CUT_R}
                fill={MOON_CUT_COL}
                opacity={1}
                fillOpacity={1}
              />
              <Path
                d={sparklePath(moonPos.x + MOON_STAR_OFF_X, moonPos.y - MOON_STAR_OFF_Y, MOON_STAR_R)}
                fill={MOON_COL}
                opacity={1}
                fillOpacity={1}
              />
            </G>

            {/* OUTER RINGS (2nd sits behind 1st) */}
            <Circle
              cx={CX}
              cy={CY}
              r={OUTER_RING2_R}
              stroke={OUTER_RING2_STROKE}
              strokeWidth={OUTER_RING2_W}
              fill={OUTER_RING2_FILL}
            />
            <Circle
              cx={CX}
              cy={CY}
              r={OUTER_RING_R}
              stroke={OUTER_RING_STROKE}
              strokeWidth={OUTER_RING_W}
              fill={OUTER_RING_FILL}
            />

            {/* Next marker stars */}
            {nextStarGroup && nextTimeKey ? (
              <G key={`nextstars-${nextTimeKey}`}>
                {nextStarGroup.extra.map((s) => (
                  <Path
                    key={`nx-extra-${s.id}`}
                    d={sparklePath(s.x, s.y, s.r)}
                    fill={SOFT_WHITE_SOLID}
                    opacity={s.id === "e1" ? 0.20 : s.id === "e2" ? 0.22 : 0.18}
                  />
                ))}

                {nextStarGroup.core.map((s) => (
                  <Path
                    key={`nx-core-${s.id}`}
                    d={sparklePath(s.x, s.y, s.r)}
                    fill={SOFT_WHITE_SOLID}
                    opacity={0.55}
                  />
                ))}
              </G>
            ) : null}

            {/* Marker arrows */}
            {markerArrows.map((m) => {
              const isNextSlot = nextSlotAngle != null && Math.abs(m.angle - nextSlotAngle) < 0.001;

              // Active (next slot) vs inactive styling
              const outerFill = isNextSlot ? MARKER_NEXT_COL : MARKER_COL;
              const outerStroke = isNextSlot ? MARKER_STROKE_ACTIVE : MARKER_STROKE_INACTIVE;
              const innerFill = isNextSlot ? MARKER_COL : MARKER_NEXT_COL;

              return (
                <G key={`mk-${m.id}`}>
                  <Path
                    d={markerArrowPath(m.angle)}
                    fill={outerFill}
                    stroke={outerStroke}
                    strokeWidth={MARKER_STROKE_W}
                    strokeLinejoin="round"
                    opacity={1}
                  />
                  <Path
                    d={markerInnerPath(m.angle)}
                    fill={innerFill}
                    stroke={innerFill}
                    strokeWidth={MARKER_STROKE_W}
                    strokeLinejoin="round"
                    opacity={MARKER_INNER_OP}
                  />
                </G>
              );
            })}
          </G>

          {/* Time hand */}
          <Line
            x1={handP1.x}
            y1={handP1.y}
            x2={handP2.x}
            y2={handP2.y}
            stroke={SOFT_WHITE}
            strokeWidth={HAND_W}
            strokeLinecap="round"
            opacity={1}
          />

          {/* Center digital display */}
          <G>
            <Path
              d={displayPillPath}
              fill="rgba(104,110,133,0.3)"
              stroke="rgba(82,91,112,0.50)"
              strokeWidth={1.5}
            />
            <SvgText
              x={CX}
              y={CY + S(1)}
              fill={SOFT_WHITE}
              fontSize={S(20)}
              fontWeight="800"
              fontFamily={FONT_ROUNDED}
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

// SECTION 10.17) Clock wrapper styles

const makeClockStyles = (scale: number) => {
  const t = (n: number) => Math.round(n * scale);
  return StyleSheet.create({
  wrap: { width: "100%", alignItems: "center", justifyContent: "flex-start", paddingTop: 0, paddingBottom: 0 },
  canvas: { width: CANVAS_SIZE, height: CANVAS_SIZE, marginTop: -10, marginBottom: -10 },
  });
};

// clockStyles are used inside PaliaClockFace (keep stable; text scaling is handled in app UI text)
const clockStyles = makeClockStyles(1);






// SECTION 11) MAIN APP


// SECTION X) Shared UI components

type ScalePressableProps = {
  onPress?: () => void;
  disabled?: boolean;
  style?: any;
  children: React.ReactNode;
  activeScale?: number;
};

// Button press: micro scale (0.98 → 1)
// NOTE: Must be top-level so hooks are always used correctly across platforms.
const ScalePressable = React.memo(function ScalePressable({
  onPress,
  disabled,
  style,
  children,
  activeScale = 0.98,
}: ScalePressableProps) {
  const s = useRef(new Animated.Value(1)).current;

  const pressIn = () => {
    if (disabled) return;
    Animated.spring(s, { toValue: activeScale, speed: 28, bounciness: 0, useNativeDriver: true }).start();
  };

  const pressOut = () => {
    Animated.spring(s, { toValue: 1, speed: 22, bounciness: 0, useNativeDriver: true }).start();
  };

  return (
    <Pressable onPress={disabled ? undefined : onPress} onPressIn={pressIn} onPressOut={pressOut}>
      <Animated.View style={[style, { transform: [{ scale: s }] }]}>{children}</Animated.View>
    </Pressable>
  );
});


export default function App() {
  useKeepAwake();

  const { height: SCREEN_H } = useWindowDimensions();

// SECTION 11.1) Core state

  const [paliaTime, setPaliaTime] = useState(getPaliaTime());
  const [markers, setMarkers] = useState<Marker[]>(DEFAULT_MARKERS);

  const [hydrated, setHydrated] = useState(false);

  // Home list mode (Events/Fish/Bugs)
  const [clockViewOpen, setClockViewOpen] = useState(false);
  const [clockViewMode, setClockViewMode] = useState<"events" | "fish" | "bugs">("events");

  // Home list mode (Events/Fish/Bugs)

// SECTION 11.1.X) Remote wiki data (minimal fetch + cache)

  const [remoteFish, setRemoteFish] = useState<any | null>(null);
  const [remoteFishStatus, setRemoteFishStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");


// SECTION 11.2) Refs

const markersRef = useRef<Marker[]>(DEFAULT_MARKERS);
const notifEnabledRef = useRef(false);
const reminderRef = useRef<ReminderLeadSeconds>(0);

// Web: in-memory timers for desktop notifications (works while tab is open)
const webTimerIdsRef = useRef<any[]>([]);

// ✅ Wheel refs (used to hard-snap scroll positions so Android stops drifting)
const hourWheelRef = useRef<ScrollView>(null as any);
const minuteWheelRef = useRef<ScrollView>(null as any);
const endHourWheelRef = useRef<ScrollView>(null as any);
const endMinuteWheelRef = useRef<ScrollView>(null as any);
const locationWheelRef = useRef<ScrollView>(null as any);

// ✅ Wheel snap state (prevents drift + “freeze” loops from repeated snap animations)
const wheelSnapLockRef = useRef({ hour: false, minute: false, endHour: false, endMinute: false, location: false });
const wheelMomentumRef = useRef({ hour: false, minute: false, endHour: false, endMinute: false, location: false });
const wheelTimeoutRef = useRef<{ hour?: any; minute?: any; endHour?: any; endMinute?: any; location?: any }>({});
const wheelLastSnapIdxRef = useRef({ hour: 0, minute: 0, endHour: 0, endMinute: 0, location: 0 });

// SECTION 11.3) Modal + form state

  const [setupOpen, setSetupOpen] = useState(false);
  const [eventDetailsOpen, setEventDetailsOpen] = useState(false);
  const [eventDetailsId, setEventDetailsId] = useState<string | null>(null);

  const eventDetailsMarker = useMemo(() => {
    if (!eventDetailsId) return null;
    return markers.find((m) => m.id === eventDetailsId) ?? null;
  }, [markers, eventDetailsId]);
  const [roadmapOpen, setRoadmapOpen] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);

  
  // Closed testing first-launch notice
  const [closedTestOpen, setClosedTestOpen] = useState(false);
// Add Marker dropdown
  const [addMarkerOpen, setAddMarkerOpen] = useState(false);

  // Time pickers (dropdown menus)
  const [hourPickerOpen, setHourPickerOpen] = useState(false);
  const [minutePickerOpen, setMinutePickerOpen] = useState(false);

  // Location picker (dropdown menu)
  const [locationPickerOpen, setLocationPickerOpen] = useState(false);

  // Folder picker (dropdown menu)
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);

  // Track whether user has actually interacted with the time (for "ghost" placeholders)
  const [timeTouched, setTimeTouched] = useState(false);

  // Track whether user has actually picked a location (for ghost placeholder)
  const [locationTouched, setLocationTouched] = useState(false);

  // Folder selection (future-proofing). For now: only "custom" is allowed for NEW markers.
  const [newFolder, setNewFolder] = useState<"default" | "custom">("custom");

  // Form fields (Event Name + Location are stored as "Name - Location" in Marker.name)
  const [newName, setNewName] = useState("");
  const [newLocation, setNewLocation] = useState("");
  const [newNotes, setNewNotes] = useState("");
  const [newHour, setNewHour] = useState("00");
  const [newMinute, setNewMinute] = useState("00");

  const [newHasRange, setNewHasRange] = useState(false);
  const [newEndHour, setNewEndHour] = useState("00");
  const [newEndMinute, setNewEndMinute] = useState("00");
  const [endTimeTouched, setEndTimeTouched] = useState(false);

  const [endHourPickerOpen, setEndHourPickerOpen] = useState(false);
  const [endMinutePickerOpen, setEndMinutePickerOpen] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);



// SECTION 11.X) Closed test first-launch popup (shown once)
useEffect(() => {
  let alive = true;
  (async () => {
    try {
      const seen = await AsyncStorage.getItem(CLOSED_TEST_POPUP_SEEN_KEY);
      if (!alive) return;
      if (!seen) setClosedTestOpen(true);
    } catch {
      // If storage fails, still show it once. Better than silence.
      if (alive) setClosedTestOpen(true);
    }
  })();
  return () => {
    alive = false;
  };
}, []);

const dismissClosedTest = useCallback(async () => {
  setClosedTestOpen(false);
  try {
    await AsyncStorage.setItem(CLOSED_TEST_POPUP_SEEN_KEY, "1");
  } catch {
    // ignore
  }
}, []);
// SECTION 11.4) Countdown + notifications state

  const [countdowns, setCountdowns] = useState<Record<string, number>>({});

  const [notifEnabled, setNotifEnabled] = useState(false);

  // Home banners
  const [notifBannerDismissed, setNotifBannerDismissed] = useState(false);
  const [whatsNewDismissed, setWhatsNewDismissed] = useState(false);

  // Prevent X-tap from also triggering banner onPress
  const bannerXGuardRef = useRef(false);

  // Prevent bell-tap from also triggering card onPress (Next/Now rows)
  const nextCardGuardRef = useRef(false);

  const [reminderLeadSeconds, setReminderLeadSeconds] = useState<ReminderLeadSeconds>(0);

  // “Want to help?” (closed testing)
  const [helpIncludeDiagnostics, setHelpIncludeDiagnostics] = useState(false);

  const [diagDeviceInfo, setDiagDeviceInfo] = useState<{
    appVersion: string;
    build: string;
    manufacturer: string;
    model: string;
    deviceType: string;
  }>({
    appVersion: "unknown",
    build: "unknown",
    manufacturer: "unknown",
    model: "unknown",
    deviceType: Platform.OS === "web" ? "web" : "unknown",
  });

  useEffect(() => {
    let alive = true;

    const deviceTypeLabel = (dt: any) => {
      if (dt === (Device as any).DeviceType?.PHONE) return "phone";
      if (dt === (Device as any).DeviceType?.TABLET) return "tablet";
      if (dt === (Device as any).DeviceType?.DESKTOP) return "desktop";
      if (dt === (Device as any).DeviceType?.TV) return "tv";
      return "unknown";
    };

    (async () => {
      try {
        const appVersion =
          Platform.OS === "web"
            ? "web"
            : (Application as any).nativeApplicationVersion ?? "unknown";
        const build =
          Platform.OS === "web" ? "web" : (Application as any).nativeBuildVersion ?? "unknown";

        let manufacturer = "unknown";
        let model = "unknown";
        let deviceType = Platform.OS === "web" ? "web" : "unknown";

        if (Platform.OS !== "web") {
          manufacturer = (Device as any).manufacturer ?? "unknown";
          model = (Device as any).modelName ?? (Device as any).modelId ?? "unknown";

          try {
            const dt = await (Device as any).getDeviceTypeAsync?.();
            deviceType = deviceTypeLabel(dt);
          } catch {
            // ignore
          }
        }

        if (!alive) return;
        setDiagDeviceInfo({ appVersion, build, manufacturer, model, deviceType });
      } catch {
        // ignore
      }
    })();

    return () => {
      alive = false;
    };
  }, []);

// SECTION 11.5) Keep refs fresh

  useEffect(() => {
    markersRef.current = markers;
  }, [markers]);

  useEffect(() => {
    notifEnabledRef.current = notifEnabled;
  }, [notifEnabled]);

  useEffect(() => {
    reminderRef.current = reminderLeadSeconds;
  }, [reminderLeadSeconds]);






// SECTION 12) LOAD STORED SETTINGS

// SECTION 12.1) Hydration loader

  useEffect(() => {
    void (async () => {
      try {
        // SECTION 12.2) Markers
        try {
          const raw = await AsyncStorage.getItem(STORAGE_MARKERS);

          let finalMarkers: Marker[] | null = null;

          if (raw) {
            const parsed = JSON.parse(raw) as unknown;

            if (Array.isArray(parsed) && parsed.length > 0) {
              const stored: Marker[] = parsed
                .map((m: unknown) => normalizeStoredMarker(m))
                .filter((m): m is Marker => !!m)
                .filter((m) => !String(m.id).startsWith("dev_hour_") && !String(m.name).startsWith("DEV •"));

              const baseFinal = stored.length ? stored : DEFAULT_MARKERS;
              finalMarkers = ensureDefaultDefaults(ensureRepeatableDefaults(baseFinal));
            } else {
              finalMarkers = ensureDefaultDefaults(ensureRepeatableDefaults(DEFAULT_MARKERS));
            }
          } else {
            finalMarkers = ensureDefaultDefaults(ensureRepeatableDefaults(DEFAULT_MARKERS));
          }

          // One-time guarantee: Repeatable Events start OFF by default.
          // (Also fixes Expo Go/dev environments where AsyncStorage can persist across reinstalls.)
          const didDefault = await AsyncStorage.getItem(STORAGE_REPEATABLE_NOTIF_DEFAULTED);
          if (!didDefault) {
            finalMarkers = finalMarkers.map((m) =>
              String(m.id).startsWith("repeat_") ? { ...m, enabled: false, notify: false } : m
            );
            await AsyncStorage.setItem(STORAGE_REPEATABLE_NOTIF_DEFAULTED, "1");
          }

          setMarkers(finalMarkers);
          await AsyncStorage.setItem(STORAGE_MARKERS, JSON.stringify(finalMarkers));
        } catch {
          // ignore
        }

        // SECTION 12.3) Notification prefs

        // One-time guarantee: Notifications start OFF by default.
        // (Also fixes dev/Expo environments where AsyncStorage can persist across reinstalls or updates.)
        try {
          const didDefault = await AsyncStorage.getItem(STORAGE_NOTIF_DEFAULTED);
          if (!didDefault) {
            notifEnabledRef.current = false;
            setNotifEnabled(false);
            setReminderLeadSeconds(0);
            await AsyncStorage.setItem(STORAGE_NOTIF_PREFS, JSON.stringify({ enabled: false, reminderLeadSeconds: 0 }));
            await AsyncStorage.setItem(STORAGE_NOTIF_DEFAULTED, "1");
          }
        } catch {
          // ignore
        }

        try {
          try {
  const rawTextSize = await AsyncStorage.getItem(STORAGE_TEXT_SIZE_MODE);
  if (rawTextSize === "small" || rawTextSize === "medium" || rawTextSize === "large") {
    setTextSizeMode(rawTextSize);
  }
} catch {
  // ignore
}

const raw = await AsyncStorage.getItem(STORAGE_NOTIF_PREFS);
          if (raw) {
            const parsed = JSON.parse(raw) as unknown;

            if (isRecord(parsed)) {
              const enabledRaw = parsed["enabled"];
              if (typeof enabledRaw === "boolean") {
                notifEnabledRef.current = enabledRaw;
                setNotifEnabled(enabledRaw);
              }

              const leadRaw = parsed["reminderLeadSeconds"];
              if (isReminderLeadSeconds(leadRaw)) {
                setReminderLeadSeconds(leadRaw);
              } else {
                const minsRaw = parsed["reminderMinutes"];
                if (typeof minsRaw === "number" && Number.isFinite(minsRaw)) {
                  setReminderLeadSeconds(snapReminderLeadSeconds(Math.round(minsRaw * 60)));
                } else {
                  const paliaMinsRaw = parsed["reminderPaliaMinutes"];
                  if (typeof paliaMinsRaw === "number" && Number.isFinite(paliaMinsRaw)) {
                    setReminderLeadSeconds(snapReminderLeadSeconds(Math.round(paliaMinsRaw * 2.5)));
                  }
                }
              }
            }
          }
        } catch {
          // ignore
        }

        // SECTION 12.4) Closed testing: “Want to help?” diagnostics opt-in
        try {
          const raw = await AsyncStorage.getItem(HELP_DIAGNOSTICS_OPTIN_KEY);
          if (raw === "1") setHelpIncludeDiagnostics(true);
        } catch {
          // ignore
        }

        // SECTION 12.5) What's New banner dismissal
        try {
          const raw = await AsyncStorage.getItem(STORAGE_WHATSNEW_DISMISSED_ID);
          if (raw === WHATS_NEW_ID) setWhatsNewDismissed(true);
        } catch {
          // ignore
        }
      } finally {
        setHydrated(true);
      }
    })();
  }, []);


// SECTION 12.X) Remote data fetch (fish.json)
// - Loads cached JSON instantly (if present)
// - Fetches fresh JSON in the background (with cadence)
// - Never blocks core app / marker rendering
useEffect(() => {
  if (!hydrated) return;

  let cancelled = false;

  void (async () => {
    let hasCached = false;

    // 1) Load cached (instant)
    try {
      const cached = await AsyncStorage.getItem(STORAGE_REMOTE_FISH_CACHE);
      if (cached && !cancelled) {
        setRemoteFish(JSON.parse(cached));
        setRemoteFishStatus("ready");
        hasCached = true;
      }
    } catch {
      // ignore
    }

    // 2) Cadence check (skip fetch if recently fetched)
    try {
      const fetchedAtRaw = await AsyncStorage.getItem(STORAGE_REMOTE_FISH_FETCHED_AT);
      if (fetchedAtRaw) {
        const last = Date.parse(fetchedAtRaw);
        if (!Number.isNaN(last)) {
          const age = Date.now() - last;
          if (age >= 0 && age < REMOTE_FISH_REFRESH_MS) {
            return; // cache still fresh enough
          }
        }
      }
    } catch {
      // ignore
    }

    // 3) Fetch fresh (background)
    try {
      setRemoteFishStatus("loading");

      // Try a small list of URLs (helps web dev if the hosted file isn't live yet)
      const urlsToTry = Platform.OS === "web"
        ? [FISH_URL_WEB_LOCAL, FISH_URL_REMOTE]
        : [FISH_URL_REMOTE, FISH_URL_RAW_MAIN, FISH_URL_RAW_MASTER];

      let json: any | null = null;
      let lastErr: any = null;

      for (const url of urlsToTry) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 12000);

          const res = await fetch(url, {
            signal: controller.signal,
            headers: { "Cache-Control": "no-cache" },
          });

          clearTimeout(timeoutId);

          if (!res.ok) throw new Error(`fish.json HTTP ${res.status} (${url})`);

          json = await res.json();
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
        }
      }

      if (!json) throw lastErr ?? new Error("fish.json fetch failed");
      if (cancelled) return;

      setRemoteFish(json);
      setRemoteFishStatus("ready");

      try {
        await AsyncStorage.setItem(STORAGE_REMOTE_FISH_CACHE, JSON.stringify(json));
        await AsyncStorage.setItem(STORAGE_REMOTE_FISH_FETCHED_AT, new Date().toISOString());
      } catch {
        // ignore
      }
    } catch {
      if (cancelled) return;

      // Fallback sanity:
      // - If cached data exists, keep it and stay "ready"
      // - If no cached data, show "error"
      setRemoteFishStatus(hasCached ? "ready" : "error");
    }
  })();

  return () => {
    cancelled = true;
  };
}, [hydrated]);

// SECTION 12.X) Sync remote fish into Event markers
// - Converts fish.json entries into protected markers (id prefix: fish_)
// - Preserves user toggles (enabled/notify) for existing fish markers
// - Updates notes/timing when fish data changes
useEffect(() => {
  if (!hydrated) return;
  if (remoteFishStatus !== "ready") return;

  const fishList = normalizeRemoteFish(remoteFish).filter((f) => !isBlockedFishEntry(f));
  if (!fishList.length) return;

  setMarkers((prev) => {
    const prevFishById = new Map<string, Marker>();
    for (const m of prev) {
      if (String(m.id).startsWith("fish_")) prevFishById.set(String(m.id), m);
    }

    // Keep all non-fish markers as-is
    const keep: Marker[] = prev.filter((m) => !String(m.id).startsWith("fish_"));

    const nextFish: Marker[] = fishList.map((f) => {
      const markerId = `fish_${f.id}`;
      const existing = prevFishById.get(markerId);

      const timing = fishAppearsToWindow(f.appears);
      const notes = buildFishNotes(f);

      const base: Marker = {
        id: markerId,
        name: f.title,
        hour: timing.hour,
        minute: timing.minute,
        enabled: false,
        notify: false,
        notes,
        hasRange: timing.hasRange,
        endHour: timing.endHour,
        endMinute: timing.endMinute,
        imageUrl: f.imageUrl,
      };

      if (!existing) return base;

      // Preserve user toggles, but refresh details from JSON
      return {
        ...base,
        enabled: existing.enabled,
        notify: existing.notify,
      };
    });

    return [...keep, ...nextFish];
  });
}, [hydrated, remoteFishStatus, remoteFish]);



// SECTION 13) PERSIST SETTINGS

// SECTION 13.1) Persist markers

  useEffect(() => {
    if (!hydrated) return;
    AsyncStorage.setItem(STORAGE_MARKERS, JSON.stringify(markers)).catch(() => {});
  }, [hydrated, markers]);

// SECTION 13.3) Persist notification prefs

  useEffect(() => {
    if (!hydrated) return;
    const prefs: NotifPrefs = { enabled: notifEnabled, reminderLeadSeconds };
    AsyncStorage.setItem(STORAGE_NOTIF_PREFS, JSON.stringify(prefs)).catch(() => {});
  }, [hydrated, notifEnabled, reminderLeadSeconds]);

  // SECTION 13.4) Persist “Want to help?” diagnostics opt-in

  useEffect(() => {
    if (!hydrated) return;
    AsyncStorage.setItem(HELP_DIAGNOSTICS_OPTIN_KEY, helpIncludeDiagnostics ? "1" : "0").catch(() => {});
  }, [hydrated, helpIncludeDiagnostics]);





// SECTION 14) COUNTDOWN TICKER

// SECTION 14.1) Init countdown map

  useEffect(() => {
    const next: Record<string, number> = {};
    for (const m of markers) next[m.id] = getSecondsUntilNextPaliaTime(m.hour, m.minute);
    setCountdowns(next);
  }, [markers]);

// SECTION 14.2) Tick loop

useEffect(() => {
  let alive = true;
  let t: any = null;

  const compute = () => {
    if (!alive) return;

    // Prevent double-scheduling (eg. foreground resync calling compute again)
    if (t) {
      clearTimeout(t);
      t = null;
    }

    const now = new Date();

    // Compute current Palia minutes ONCE (so time + countdowns are in sync)
    const secondsIntoHour =
      now.getMinutes() * 60 + now.getSeconds() + now.getMilliseconds() / 1000;

    const currentPaliaMinutes = (secondsIntoHour / 3600) * 1440; // 0..1440

    // Update displayed Palia time from the same "now"
    const hour = Math.floor(currentPaliaMinutes / 60) % 24;
    const minute = Math.floor(currentPaliaMinutes % 60);

    setPaliaTime({
      hour,
      minute,
      formatted24: `${pad2(hour)}:${pad2(minute)}`,
      formatted12: format12hTime(hour, minute),
    });

    // Recompute countdowns from absolute time (no drift)
    const ms = markersRef.current;
    const next: Record<string, number> = {};

    for (const m of ms) {
      let targetPaliaMinutes = m.hour * 60 + m.minute;
      if (targetPaliaMinutes <= currentPaliaMinutes) targetPaliaMinutes += 1440;

      const paliaMinutesRemaining = targetPaliaMinutes - currentPaliaMinutes;
      const realSecondsRemaining = (paliaMinutesRemaining / 1440) * 3600;

      // Rounded up so it doesn't show "00:00" early
      next[m.id] = Math.max(0, Math.ceil(realSecondsRemaining));
    }

    setCountdowns(next);

    // Align next tick to the next real second boundary (reduces jitter)
    const delay = 1000 - now.getMilliseconds();
    t = setTimeout(compute, Math.max(16, delay));
  };

  compute();

  // On native, timers can pause/throttle in background. Recompute immediately on resume.
  const sub =
    AppState.addEventListener("change", (state) => {
          if (state === "active") compute();
        });

  return () => {
    alive = false;
    if (t) clearTimeout(t);
    sub?.remove();
  };
}, []);





// SECTION 15) DERIVED UI LISTS
// SECTION 15.1) List layout vars (fixed)

  const densityVars = useMemo(() => {
    return { rowPadV: 12, nameSize: 14, metaSize: 11, countdownSize: 11 };
  }, []);

// SECTION 15.2) Sorted lists + next info

  const sortedMarkers = useMemo(() => {
    return [...markers].sort((a, b) => (countdowns[a.id] ?? 9e15) - (countdowns[b.id] ?? 9e15));
  }, [markers, countdowns]);

  // “Folders”
  const defaultMarkers = useMemo(() => {
    return sortedMarkers.filter((m) => String(m.id).startsWith("default_"));
  }, [sortedMarkers]);

  // Repeatable Events (id prefix: repeat_)
  const repeatableMarkers = useMemo(() => {
    return sortedMarkers.filter((m) => String(m.id).startsWith("repeat_"));
  }, [sortedMarkers]);

  // Fish Events (id prefix: fish_)
  const fishMarkers = useMemo(() => {
    return sortedMarkers.filter((m) => String(m.id).startsWith("fish_"));
  }, [sortedMarkers]);

  // Custom = everything else (non-default, non-repeatable, non-fish)
  const customMarkers = useMemo(() => {
    return sortedMarkers.filter(
      (m) =>
        !String(m.id).startsWith("default_") &&
        !String(m.id).startsWith("repeat_") &&
        !String(m.id).startsWith("fish_")
    );
  }, [sortedMarkers]);

  const enabledMarkers = useMemo(() => sortedMarkers.filter((m) => m.enabled), [sortedMarkers]);

  // Home screen list source (Now + Next cards) is driven by the clock "eye" view.
  // - Events: default + repeatable + custom
  // - Fish: fish events only
  // - Bugs: none (not wired yet)
  const homeListMarkers = useMemo(() => {
    if (!enabledMarkers.length) return [] as Marker[];

    if (clockViewMode === "bugs") return [] as Marker[];

    if (clockViewMode === "fish") {
      return enabledMarkers.filter((m) => String(m.id).startsWith("fish_"));
    }

    // "events"
    return enabledMarkers.filter((m) => !String(m.id).startsWith("fish_"));
  }, [enabledMarkers, clockViewMode]);


  const nextTimeKey = useMemo(() => {
    if (!enabledMarkers.length) return null;
    const first = enabledMarkers[0];
    return `${pad2(first.hour)}:${pad2(first.minute)}`;
  }, [enabledMarkers]);

  const nextDigitalLabel = useMemo(() => {
    if (!enabledMarkers.length) return "—";
    const first = enabledMarkers[0];
    return format12hTime(first.hour, first.minute);
  }, [enabledMarkers]);

  // Countdown pill for the “Next” box (raw seconds + m:ss label)
  const nextCountdownSeconds = useMemo(() => {
    if (!enabledMarkers.length) return 0;
    const first = enabledMarkers[0];
    return Math.max(0, countdowns[first.id] ?? 0);
  }, [enabledMarkers, countdowns]);

  const nextCountdownLabel = useMemo(() => {
    if (!enabledMarkers.length) return "—";
    const cd = nextCountdownSeconds;
    const mm = Math.floor(cd / 60);
    const ss = cd % 60;
    return `${mm}:${pad2(ss)}`;
  }, [enabledMarkers, nextCountdownSeconds]);

  const activeTimeOfDay = useMemo<"morning" | "day" | "evening" | "night">(() => {
    const mm = paliaTime.hour * 60 + paliaTime.minute;

    // 03:00–06:00 morning, 06:00–18:00 day, 18:00–21:00 evening, 21:00–03:00 night
    if (mm >= 3 * 60 && mm < 6 * 60) return "morning";
    if (mm >= 6 * 60 && mm < 18 * 60) return "day";
    if (mm >= 18 * 60 && mm < 21 * 60) return "evening";
    return "night";
  }, [paliaTime.hour, paliaTime.minute]);

  // --- Cozy “Next” groups (by time) ---
  // Shows a few upcoming time slots, each with its events as gentle rows.
  //
  // IMPORTANT:
  // Locations can contain " - " internally (e.g., "K - Kilima Village", "B - Bahari Bay", "E - Elderwoods").
  // So we split on the FIRST " - " only. Using lastIndexOf() incorrectly drags "K -" into the event name.
  const splitName = (name: string) => {
    const idx = name.indexOf(" - ");
    if (idx <= 0) return { eventName: name.trim(), location: "" };
    const eventName = name.slice(0, idx).trim();
    const location = name.slice(idx + 3).trim();
    return { eventName, location };
  };

  // --- "Now" (active) events ---
  // Active = enabled events that have a duration window and the current Palian time falls inside it.
  // Range can wrap past midnight (e.g., 22:00 -> 02:00).
  const isActiveNow = (m: Marker, hour: number, minute: number) => {
    if (!m.hasRange) return false;
    if (typeof m.endHour !== "number" || typeof m.endMinute !== "number") return false;

    const now = hour * 60 + minute;
    const start = m.hour * 60 + m.minute;
    const end = (m.endHour as number) * 60 + (m.endMinute as number);

    if (start === end) return false;

    if (start < end) return now >= start && now < end;
    // Wrap across midnight
    return now >= start || now < end;
  };

  const minutesUntil = (fromH: number, fromM: number, toH: number, toM: number) => {
    const from = fromH * 60 + fromM;
    let to = toH * 60 + toM;
    if (to <= from) to += 1440;
    return to - from;
  };

  type NowItem = {
    id: string;
    eventName: string;
    location: string;
    // Range times (used for Ends In + progress)
    startHour: number;
    startMinute: number;
    endHour: number;
    endMinute: number;
    totalRangeMins: number;

    endsInMins: number;
    endLabel: string;
  };

  const nowItems = useMemo<NowItem[]>(() => {
    if (!homeListMarkers.length) return [];

    const out: NowItem[] = [];
    for (const m of homeListMarkers) {

      if (!isActiveNow(m, paliaTime.hour, paliaTime.minute)) continue;

      const { eventName, location } = splitName(m.name);
      const eh = (m.endHour as number) ?? m.hour;
      const em = (m.endMinute as number) ?? m.minute;

      const totalRangeMins = minutesUntil(m.hour, m.minute, eh, em);

      out.push({
        id: m.id,
        eventName,
        location,
        startHour: m.hour,
        startMinute: m.minute,
        endHour: eh,
        endMinute: em,
        totalRangeMins,
        endsInMins: minutesUntil(paliaTime.hour, paliaTime.minute, eh, em),
        endLabel: format12hTime(eh, em),
      });
    }

    // Soonest ending first
    out.sort((a, b) => a.endsInMins - b.endsInMins);
    return out;
  }, [homeListMarkers, paliaTime.hour, paliaTime.minute]);

  // Palia time runs 24h in ~1 real hour => 1440 palia minutes per 3600 real seconds.
  const REAL_SEC_PER_PALIA_MIN = 3600 / 1440; // 2.5s

  const nowSoonest = nowItems.length ? nowItems[0] : null;
  const nowSoonestEndsInSec = nowSoonest ? Math.max(0, Math.round(nowSoonest.endsInMins * REAL_SEC_PER_PALIA_MIN)) : 0;
  const nowSoonestTotalSec = nowSoonest ? Math.max(1, Math.round(nowSoonest.totalRangeMins * REAL_SEC_PER_PALIA_MIN)) : 1;
  const nowSoonestFrac = nowSoonest ? Math.max(0, Math.min(1, nowSoonestEndsInSec / nowSoonestTotalSec)) : 0;
  const nowSoonestKey = nowSoonest ? `${nowSoonest.endHour}:${nowSoonest.endMinute}` : "";

  type NextTimeItem = {
    id: string;
    eventName: string;
    location: string;
    countdownSec: number;
  };

  type NextTimeGroup = {
    timeKey: string;
    timeLabel: string;
    items: NextTimeItem[];
  };


  const [nextTimeFilter, setNextTimeFilter] = useState<"morning" | "day" | "evening" | "night" | null>(null);

  const isMinuteInTimeOfDay = (mm: number, tod: "morning" | "day" | "evening" | "night") => {
    // 03:00–06:00 morning, 06:00–18:00 day, 18:00–21:00 evening, 21:00–03:00 night
    if (tod === "morning") return mm >= 3 * 60 && mm < 6 * 60;
    if (tod === "day") return mm >= 6 * 60 && mm < 18 * 60;
    if (tod === "evening") return mm >= 18 * 60 && mm < 21 * 60;
    return mm >= 21 * 60 || mm < 3 * 60;
  };

  const sortKeyForTimeOfDay = (mm: number, tod: "morning" | "day" | "evening" | "night") => {
    // Keep “night” in human-friendly order: 21:00..23:59, then 00:00..02:59
    if (tod === "night" && mm < 3 * 60) return mm + 1440;
    return mm;
  };

  const nextTimeGroups = useMemo<NextTimeGroup[]>(() => {
    if (!homeListMarkers.length) return [];

    const filtering = nextTimeFilter != null;

    // Fish view is a pure “show me everything” experience, so don't cap.
    const noCap = clockViewMode === "fish";

    // Default: cozy “guide” (limited groups/items). Filtered: show EVERYTHING in that time-of-day.
    const MAX_GROUPS = filtering || noCap ? 9999 : 3; // distinct time headers
    const MAX_ITEMS = filtering || noCap ? 9999 : 8;  // total rows across all groups

    const source = filtering
      ? homeListMarkers
          .filter((m) => isMinuteInTimeOfDay(m.hour * 60 + m.minute, nextTimeFilter!))
          .slice()
          .sort((a, b) => {
            const am = a.hour * 60 + a.minute;
            const bm = b.hour * 60 + b.minute;
            const ak = sortKeyForTimeOfDay(am, nextTimeFilter!);
            const bk = sortKeyForTimeOfDay(bm, nextTimeFilter!);
            if (ak !== bk) return ak - bk;
            return String(a.name).localeCompare(String(b.name));
          })
      : homeListMarkers;

    const groups: NextTimeGroup[] = [];
    const indexByTimeKey = new Map<string, number>();

    let total = 0;

    for (const m of source) {
      if (total >= MAX_ITEMS) break;

      const timeKey = `${pad2(m.hour)}:${pad2(m.minute)}`;
      const existingIdx = indexByTimeKey.get(timeKey);

      // If this would create a new group and we’re already full, stop.
      if (existingIdx == null && groups.length >= MAX_GROUPS) break;

      const timeLabel = format12hTime(m.hour, m.minute);
      const { eventName, location } = splitName(m.name);

      const item: NextTimeItem = {
        id: m.id,
        eventName,
        location,
        countdownSec: Math.max(0, countdowns[m.id] ?? 0),
      };

      if (existingIdx == null) {
        indexByTimeKey.set(timeKey, groups.length);
        groups.push({ timeKey, timeLabel, items: [item] });
      } else {
        groups[existingIdx].items.push(item);
      }

      total += 1;
    }

    return groups;
  }, [homeListMarkers, countdowns, nextTimeFilter, clockViewMode]);





// SECTION 16) MARKER ACTIONS

// SECTION 16.1) Form helpers

  function resetForm() {
    setEditingId(null);
    setAddMarkerOpen(false);

    // close any open dropdowns
    setHourPickerOpen(false);
    setMinutePickerOpen(false);
    setEndHourPickerOpen(false);
    setEndMinutePickerOpen(false);
    setLocationPickerOpen(false);
    setFolderPickerOpen(false);

    // reset fields
    setNewName("");
    setNewLocation("");
    setNewNotes("");
    setNewHour("00");
    setNewMinute("00");
    setNewHasRange(false);
    setNewEndHour("00");
    setNewEndMinute("00");
    setEndTimeTouched(false);

    // default new markers into Custom folder (Default is not allowed for user-defined markers)
    setNewFolder("custom");

    // ghost until user actually selects via scroll / picker
    setTimeTouched(false);
    setLocationTouched(false);
  }

  function openAddMarker() {
    // Fresh form, then open the dropdown
    setEditingId(null);

    setNewName("");
    setNewLocation("");
    setNewNotes("");
    setNewHour("00");
    setNewMinute("00");
    setNewHasRange(false);
    setNewEndHour("00");
    setNewEndMinute("00");
    setEndTimeTouched(false);

    setHourPickerOpen(false);
    setMinutePickerOpen(false);
    setEndHourPickerOpen(false);
    setEndMinutePickerOpen(false);
    setLocationPickerOpen(false);
    setFolderPickerOpen(false);

    // default new markers into Custom folder
    setNewFolder("custom");

    // ghost until user actually selects via scroll / picker
    setTimeTouched(false);
    setLocationTouched(false);

    setAddMarkerOpen(true);
  }

  function openEventDetails(marker: Marker) {
    // Delay open by a tick so the tap that selected the row doesn't instantly hit the backdrop.
    setEventDetailsId(marker.id);
    requestAnimationFrame(() => setEventDetailsOpen(true));
  }

  function startEdit(marker: Marker) {
    if (isProtectedMarkerId(marker.id)) return;
    setEditingId(marker.id);

    // Split "Event - Location" back into fields (best-effort)
    const parts = marker.name.split(" - ");
    const eventName = (parts.shift() ?? marker.name).trim();
    const loc = parts.join(" - ").trim();

    setNewName(eventName);
    setNewLocation(loc);
    setNewNotes(marker.notes ?? "");
    setNewHour(pad2(marker.hour));
    setNewMinute(pad2(marker.minute));

    const hasRange = !!marker.hasRange && typeof marker.endHour === "number" && typeof marker.endMinute === "number";
    setNewHasRange(hasRange);
    setNewEndHour(pad2(hasRange ? (marker.endHour as number) : marker.hour));
    setNewEndMinute(pad2(hasRange ? (marker.endMinute as number) : marker.minute));
    setEndTimeTouched(hasRange);

    setHourPickerOpen(false);
    setMinutePickerOpen(false);
    setEndHourPickerOpen(false);
    setEndMinutePickerOpen(false);
    setLocationPickerOpen(false);
    setFolderPickerOpen(false);

    // Editing should NOT look ghosted
    setTimeTouched(true);
    setLocationTouched(true);

    // Folder display (not editable for now). Default markers stay in Default.
    const isDefault = String(marker.id).startsWith("default_");
    setNewFolder(isDefault ? "default" : "custom");

    // Editing should always show the dropdown
    setAddMarkerOpen(true);
  }

// SECTION 16.2) Mutations

  function toggleEnabled(id: string) {
    setMarkers((prev) => prev.map((m) => (m.id === id ? { ...m, enabled: !m.enabled } : m)));
  }

  function toggleNotify(id: string) {
    setMarkers((prev) => prev.map((m) => (m.id === id ? { ...m, notify: !m.notify } : m)));
  }

  // Bulk helpers (folder actions)
  function setEnabledForMany(ids: string[], enabled: boolean) {
    const idSet = new Set(ids);
    setMarkers((prev) => prev.map((m) => (idSet.has(m.id) ? { ...m, enabled } : m)));
  }

  function setNotifyForMany(ids: string[], notify: boolean) {
    const idSet = new Set(ids);
    setMarkers((prev) => prev.map((m) => (idSet.has(m.id) ? { ...m, notify } : m)));
  }

  function addOrSave() {
    const eventName = newName.trim() || "Event";
    const loc = newLocation.trim();
    const notes = newNotes.trim();

    const isDefaultEdit = !!editingId && editingId.startsWith("default_");

    // User-defined markers MUST have a location
    if (!isDefaultEdit && !loc) return;

    const name = loc ? `${eventName} - ${loc}` : eventName;
    const { h, m } = clampTimeInputs(newHour, newMinute);
    const end = clampTimeInputs(newEndHour, newEndMinute);

    if (editingId) {
      setMarkers((prev) =>
        prev.map((mk) =>
          mk.id === editingId
            ? {
                ...mk,
                name,
                hour: h,
                minute: m,
                notes: notes || undefined,
                hasRange: newHasRange ? true : false,
                endHour: newHasRange ? end.h : undefined,
                endMinute: newHasRange ? end.m : undefined,
              }
            : mk
        )
      );
      resetForm();
      return;
    }

    // Folder for new markers:
    // - Default folder is NOT allowed for user-defined markers
    // - Until future folders exist, everything new goes into "custom"
    const folderKey: "custom" = "custom";

    setMarkers((prev) => [
      {
        id: `${folderKey}_${makeId()}`,
        name,
        hour: h,
        minute: m,
        enabled: true,
        notify: true,
        notes: notes || undefined,
        hasRange: newHasRange ? true : false,
        endHour: newHasRange ? end.h : undefined,
        endMinute: newHasRange ? end.m : undefined,
      },
      ...prev,
    ]);
    resetForm();
  }

  function deleteMarker(id: string) {
    if (isProtectedMarkerId(id)) return;
    if (editingId === id) resetForm();
    setMarkers((prev) => prev.filter((m) => m.id !== id));
  }





// SECTION 17) NOTIFICATION ACTIONS

// SECTION 17.1) Resync gate

  const resyncGateRef = useRef({ inFlight: false, queued: false, lastAt: 0 });

// SECTION 17.2) Resync scheduler

  const resyncTimeNotifications = useCallback(async () => {
    if (!notifEnabledRef.current) return;

    // ---- Web: schedule in-memory timeouts (desktop notifications) ----
    if (Platform.OS === "web") {
      // Clear any existing timers first
      for (const t of webTimerIdsRef.current) {
        try { clearTimeout(t); } catch {}
      }
      webTimerIdsRef.current = [];

      const perm = await ensureWebNotificationPermission();
      if (!perm.ok) {
        // If the user denied permission, reflect that by turning off notifications.
        notifEnabledRef.current = false;
        setNotifEnabled(false);
        return;
      }

      const enabledForNotif = markersRef.current.filter((m) => m.enabled && m.notify);
      const groups = groupEnabledMarkersByTime(enabledForNotif);

      if (__DEV__) {
        console.log(
          `[web-notif] resync: enabledForNotif=${enabledForNotif.length} groups=${groups.length} lead=${reminderRef.current}s`
        );
      }

      if (groups.length === 0) return;

      // Horizon: schedule a modest number ahead (keeps it stable + avoids “timer soup”).
      const OCC_PER_GROUP = 6;

      for (const group of groups) {
        const baseMs = getMsUntilNextPaliaTime(group.hour, group.minute);
        const leadMs = reminderRef.current * 1000;

        for (let cycle = 0; cycle < OCC_PER_GROUP; cycle += 1) {
          const eventInMs = baseMs + cycle * 3600 * 1000; // repeats every real hour
          const fireInMs = eventInMs - leadMs;

          // Same “don’t instant-fire on resync” guard as native
          if (fireInMs <= 1200) continue;

          const { title, body } = buildGroupNotificationText(group, reminderRef.current);

          const tid = setTimeout(() => {
            // If user toggled off since scheduling, do nothing
            if (!notifEnabledRef.current) return;

            fireWebNotification(title, body);

            // Keep the horizon rolling forward
            resyncTimeNotifications().catch(() => {});
          }, fireInMs);

          webTimerIdsRef.current.push(tid);
        }
      }

      return;
    }

    // ---- Native: schedule OS notifications ----

    const gate = resyncGateRef.current;
    gate.queued = true;
    if (gate.inFlight) return;

    gate.inFlight = true;
    try {
      while (gate.queued) {
        gate.queued = false;
        if (!notifEnabledRef.current) return;

        const enabledForNotif = markersRef.current.filter((m) => m.enabled && m.notify);

        // We schedule notifications PER PALIA TIME (HH:MM)
        const groups = groupEnabledMarkersByTime(enabledForNotif);

        if (__DEV__) {
          console.log(
            `[notif] resync: enabledForNotif=${enabledForNotif.length} groups=${groups.length} lead=${reminderRef.current}s`
          );
        }

        // Always ensure permissions + android channel before scheduling
        const perm = await ensurePermission(false);
        if (!perm.ok) return;

        // Clear existing scheduled notifications.
        // NOTE: Android doesn't always reliably round-trip `content.data` in getAllScheduledNotificationsAsync.
        // So: try targeted cancel; if that yields 0 but there are scheduled notifs, fall back to cancelAll.
        try {
          const existing = await Notifications.getAllScheduledNotificationsAsync();

          const idsToCancel = existing
            .filter((n: any) => {
              const data = n?.content?.data;
              return data && typeof data === "object" && data.type === "time_group";
            })
            .map((n: any) => n.identifier)
            .filter((id: unknown): id is string => typeof id === "string" && id.length > 0);

          if (idsToCancel.length > 0) {
            for (const id of idsToCancel) {
              await Notifications.cancelScheduledNotificationAsync(id);
            }
            if (__DEV__) console.log(`[notif] cancelled ${idsToCancel.length} existing time_group notifications`);
          } else if (existing.length > 0) {
            await Notifications.cancelAllScheduledNotificationsAsync();
            if (__DEV__) console.log(`[notif] cancelled ALL scheduled notifications (fallback). count=${existing.length}`);
          }
        } catch (e) {
          if (__DEV__) console.warn("[notif] cancel existing failed:", errMsg(e));
        }

        // If nothing is enabled for notifications, we're done.
        if (groups.length === 0) {
          gate.lastAt = Date.now();
          return;
        }

        // iOS practical limit is 64 scheduled notifications.
        // Android: keep the horizon modest to avoid OEM throttling.
        const IOS_MAX_TOTAL = 64;
        const ANDROID_TARGET_OCC_PER_GROUP = 6; // 6 hours ahead per time-group (cycle repeats hourly).

        const MAX_TOTAL =
          Platform.OS === "ios"
            ? IOS_MAX_TOTAL
            : Math.min(720, groups.length * ANDROID_TARGET_OCC_PER_GROUP);

        const perTime =
          Platform.OS === "ios"
            ? Math.min(ANDROID_TARGET_OCC_PER_GROUP, Math.max(1, Math.floor(MAX_TOTAL / groups.length)))
            : Math.min(ANDROID_TARGET_OCC_PER_GROUP, Math.max(1, Math.floor(MAX_TOTAL / groups.length)));

        let totalScheduled = 0;

        for (const group of groups) {
          const remaining = MAX_TOTAL - totalScheduled;
          if (remaining <= 0) break;

          const occurrences = Math.min(perTime, remaining);

          const ids = await scheduleTimeGroupOccurrences({
            group,
            reminderLeadSeconds: reminderRef.current,
            occurrences,
          });

          totalScheduled += ids.length;
        }

        gate.lastAt = Date.now();

        if (__DEV__) {
          const after = await Notifications.getAllScheduledNotificationsAsync();
          console.log(
            `[notif] scheduled total=${totalScheduled} (platformCap=${MAX_TOTAL}) scheduledNow=${after.length}`
          );
        }
      }
    } catch (e) {
      if (__DEV__) console.warn("[notif] resync failed:", errMsg(e));
    } finally {
      gate.inFlight = false;

      if (gate.queued && notifEnabledRef.current) {
        setTimeout(() => {
          resyncTimeNotifications().catch(() => {});
        }, 0);
      }
    }
  }, []);

// SECTION 17.3) Toggle notifications

  const toggleNotifications = useCallback(async () => {
    // Turning ON
    if (!notifEnabledRef.current) {
      // Web: request browser permission
      if (Platform.OS === "web") {
        const perm = await ensureWebNotificationPermission();
        if (!perm.ok) return;

        notifEnabledRef.current = true;
        setNotifEnabled(true);

        await resyncTimeNotifications();
        return;
      }

      // Native: request OS permission
      const perm = await ensurePermission(true);
      if (!perm.ok) {
        Alert.alert(
          "Notifications not enabled",
          "Permission wasn’t granted. You can enable notifications for this app in your device settings.",
          [
            { text: "Cancel", style: "cancel" },
            { text: "Open Settings", onPress: () => Linking.openSettings().catch(() => {}) },
          ]
        );
        return;
      }

      notifEnabledRef.current = true;
      setNotifEnabled(true);

      await resyncTimeNotifications();
      return;
    }

    // Turning OFF
    notifEnabledRef.current = false;
    setNotifEnabled(false);
    setReminderLeadSeconds(0);

    resyncGateRef.current.queued = false;

    // Web: clear in-memory timers
    if (Platform.OS === "web") {
      for (const t of webTimerIdsRef.current) {
        try {
          clearTimeout(t);
        } catch {}
      }
      webTimerIdsRef.current = [];
      return;
    }

    try {
      await Notifications.cancelAllScheduledNotificationsAsync();
    } catch (e) {
      console.warn("[notif] cancel failed:", errMsg(e));
    }
  }, [resyncTimeNotifications]);


// SECTION 17.4) Hard cancel when notifications are turned OFF (Settings toggle safety)

  useEffect(() => {
    if (!hydrated) return;

    // When the user turns notifications off, cancel anything already scheduled.
    if (notifEnabled) return;

    // Stop any queued resync loop.
    resyncGateRef.current.queued = false;

    // Web: clear in-memory timers
    if (Platform.OS === "web") {
      for (const t of webTimerIdsRef.current) {
        try {
          clearTimeout(t);
        } catch {}
      }
      webTimerIdsRef.current = [];
      return;
    }

    // Native: cancel scheduled OS notifications
    Notifications.cancelAllScheduledNotificationsAsync().catch(() => {});
  }, [notifEnabled, hydrated]);






  // SECTION 17.3) Manual refresh (UI button)

  const REFRESH_COOLDOWN_MS = 10_000;
  const refreshCooldownUntilRef = useRef(0);
  const refreshCooldownTimerRef = useRef<any>(null);
  const [refreshCooldownUntil, setRefreshCooldownUntil] = useState(0);

  const refreshCoolingDown = refreshCooldownUntil > 0 && Date.now() < refreshCooldownUntil;

  const startRefreshCooldown = useCallback(() => {
    const until = Date.now() + REFRESH_COOLDOWN_MS;
    refreshCooldownUntilRef.current = until;
    setRefreshCooldownUntil(until);

    if (refreshCooldownTimerRef.current) {
      try {
        clearTimeout(refreshCooldownTimerRef.current);
      } catch {}
    }

    refreshCooldownTimerRef.current = setTimeout(() => {
      refreshCooldownUntilRef.current = 0;
      setRefreshCooldownUntil(0);
    }, REFRESH_COOLDOWN_MS);
  }, []);

  const manualResyncNotifications = useCallback(async () => {
    // Prevent spam taps while the UI is still showing the success message.
    if (Date.now() < refreshCooldownUntilRef.current) return;

    if (!notifEnabledRef.current) {
      try {
        Alert.alert("Notifications are off", "Turn notifications on first, then refresh scheduling.");
      } catch {}
      return;
    }

    startRefreshCooldown();

    try {
      await resyncTimeNotifications();
      try {
        Alert.alert("Refreshed", "Notification scheduling has been refreshed.");
      } catch {}
    } catch (e) {
      try {
        Alert.alert("Refresh failed", errMsg(e));
      } catch {}
    }
  }, [resyncTimeNotifications, startRefreshCooldown]);

  useEffect(() => {
    return () => {
      if (refreshCooldownTimerRef.current) {
        try {
          clearTimeout(refreshCooldownTimerRef.current);
        } catch {}
      }
    };
  }, []);

// SECTION 18) AUTO-RESYNC

// SECTION 18.1) Resync on state changes

  useEffect(() => {
    if (!hydrated || !notifEnabled) return;
    resyncTimeNotifications().catch(() => {});
  }, [markers, reminderLeadSeconds, notifEnabled, hydrated, resyncTimeNotifications]);

// SECTION 18.2) Resync on foreground

  useEffect(() => {
    if (!hydrated || Platform.OS === "web") return;

    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        // If notifications are OFF, allow the banner to re-show on app reopen/foreground.
        if (!notifEnabledRef.current) setNotifBannerDismissed(false);
        if (notifEnabledRef.current) resyncTimeNotifications().catch(() => {});
      }
    });

    return () => sub.remove();
  }, [hydrated, resyncTimeNotifications]);





// SECTION 18.4) Closed testing: “Want to help?” helpers

const CLOSED_TEST_KNOWN_ISSUES = [
  "Android: notification delivery can be delayed if battery optimisations are aggressive (see helper under the notifications 'Status').",
];

const CLOSED_TEST_WHAT_TO_TEST = [
  "Open/close the side menu and Settings menu: background should only blur (no brightness/flicker changes).",
  "Toggle notifications ON (first time): permission prompt should appear only when enabling.",
  "Set a reminder lead-time and confirm the next notification arrives roughly on time (depending on your settings).",
  "Create/edit/delete an Event and confirm it appears on the home screen clock and in the 'Next' list correctly.",
  "Toggle Event enabled/notify and confirm scheduling updates correctly.",
];


  const buildDiagnostics = useCallback(() => {
    const lines: string[] = [];
    lines.push("Palia Event Tracker diagnostics");
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push("");
    lines.push(`App Version: ${diagDeviceInfo.appVersion}`);
    lines.push(`Build: ${diagDeviceInfo.build}`);
    lines.push(`Device: ${diagDeviceInfo.manufacturer} ${diagDeviceInfo.model}`);
    lines.push(`Device type: ${diagDeviceInfo.deviceType}`);
    lines.push("");
    lines.push(`Platform: ${Platform.OS} (version ${String(Platform.Version)})`);
    lines.push("");
    const ms = markersRef.current;
    lines.push(`Events: total=${ms.length}`);
    lines.push(
      `Enabled=${ms.filter((mm) => mm.enabled).length} | Notify=${ms.filter((mm) => mm.enabled && mm.notify).length}`
    );
    lines.push(`Notifications setting: ${notifEnabledRef.current ? "ON" : "OFF"}`);
    lines.push(`Reminder lead: ${formatReminderChip(reminderRef.current)}`);
    return lines.join("\n");
  }, [diagDeviceInfo]);

  const sendHelpEmail = useCallback(
    async (kind: "feedback" | "bug" | "feature") => {
      const to = "daleowendigital@gmail.com";

      const subjectBase =
        kind === "feedback" ? "Feedback" : kind === "bug" ? "Bug report" : "Feature request";
      const subject = `Palia Event Tracker - ${subjectBase}`;

      const intro =
        kind === "bug"
          ? "What happened?\n\nWhat did you expect?\n\nSteps to reproduce (if you can):\n\n"
          : kind === "feature"
          ? "What would you like to add/change?\n\nWhy would it help?\n\n"
          : "What did you like / what should change?\n\n";

      const diag = helpIncludeDiagnostics ? `\n\n---\n\n${buildDiagnostics()}` : "";
      const body = `${intro}${diag}`;

      const mailto = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(
        subject
      )}&body=${encodeURIComponent(body)}`;

      try {
        await Linking.openURL(mailto);
      } catch {
        Alert.alert("Email not available", "Could not open an email composer on this device.");
      }
    },
    [buildDiagnostics, helpIncludeDiagnostics]
  );

  const shareDiagnostics = useCallback(async () => {
    try {
      await Share.share({ message: buildDiagnostics() });
    } catch {
      Alert.alert("Share failed", "Could not share diagnostics from this device.");
    }
  }, [buildDiagnostics]);


  const resetAppData = useCallback(() => {
    Alert.alert(
      "Reset app data?",
      "This will clear your saved events, notification preferences, and settings on this device.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reset",
          style: "destructive",
          onPress: async () => {
            try {
              await AsyncStorage.multiRemove([
                STORAGE_MARKERS,
                STORAGE_REPEATABLE_NOTIF_DEFAULTED,
                STORAGE_NOTIF_PREFS,
                STORAGE_NOTIF_DEFAULTED,
                STORAGE_WHATSNEW_DISMISSED_ID,
                NEXT_TIME_COUNT_KEY,
                HELP_DIAGNOSTICS_OPTIN_KEY,
                CLOSED_TEST_POPUP_SEEN_KEY,
              ]);

              try {
                await Notifications.cancelAllScheduledNotificationsAsync();
              } catch {
                // ignore
              }

              // Reset in-memory state to fresh defaults
              setMarkers(DEFAULT_MARKERS);
              notifEnabledRef.current = false;
              setNotifEnabled(false);
              setReminderLeadSeconds(0);
              setNextTimeCount(2);
              setHelpIncludeDiagnostics(false);
              setClosedTestOpen(true);
              setWhatsNewDismissed(false);
            } catch {
              Alert.alert("Reset failed", "Could not reset app data on this device.");
            }
          },
        },
      ]
    );
  }, []);

// SECTION 18.3) Resync on notification TAP (not on receive)


  useEffect(() => {
    if (!hydrated || Platform.OS === "web") return;

    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      if (!notifEnabledRef.current) return;

      const data: any = response?.notification?.request?.content?.data;
      if (data?.type !== "time_group") return;

      resyncTimeNotifications().catch(() => {});
    });

    return () => sub.remove();
  }, [hydrated, resyncTimeNotifications]);





// SECTION 19) UI

// SECTION 19.1) UI state

  // Backdrop blur strength used by side menu + settings modal (BlurView)
  // Tune these if you want the blur heavier/lighter.
  const BACKDROP_BLUR_INTENSITY = 55;

  // Safe area insets (used by drawer positioning)
  const insets = useSafeAreaInsets();

  // Screen width (drawer sizing)
  const { width: SCREEN_W } = useWindowDimensions();

  // Drawer width (keeps it cozy, not “full-screen terror”)

  const [textSizeMode, setTextSizeMode] = useState<TextSizeMode>("medium");

  const textScale = useMemo(() => {
    return textSizeMode === "small" ? 1.0 : textSizeMode === "large" ? 1.2 : 1.1;
  }, [textSizeMode]);

  const setTextSizeModePersist = useCallback(async (mode: TextSizeMode) => {
    setTextSizeMode(mode);
    try {
      await AsyncStorage.setItem(STORAGE_TEXT_SIZE_MODE, mode);
    } catch {
      // ignore
    }
  }, []);

  const styles = useMemo(() => makeStyles(textScale), [textScale]);

  const DRAWER_W = useMemo(() => {
    return Math.min(360, Math.max(280, Math.round(SCREEN_W * 0.8)));
  }, [SCREEN_W]);

  const [rotateClock, setRotateClock] = useState(false);

  const [nextTimeCount, setNextTimeCount] = useState<1 | 2 | 3>(2);

  // Home screen quick notes ("Next" list). Matches the inline Notes drop used on Event Setup.
  const [expandedNextNotesId, setExpandedNextNotesId] = useState<string | null>(null);
  const [expandedNowNotesId, setExpandedNowNotesId] = useState<string | null>(null);


  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const v = await AsyncStorage.getItem(NEXT_TIME_COUNT_KEY);
        if (!mounted) return;
        const n = Number(v);
        if (n === 1 || n === 2 || n === 3) {
          setNextTimeCount(n);
        }
      } catch {}
    })();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    AsyncStorage.setItem(NEXT_TIME_COUNT_KEY, String(nextTimeCount)).catch(() => {});
  }, [nextTimeCount]);

  // Used to “reroll” tiny decorative randomness without reworking the whole clock.
  // If you don’t want rerolls, keep it at 0 forever.
  const [starSeedSalt, setStarSeedSalt] = useState(0);

  const [screen, setScreen] = useState<"home" | "marker_setup">("home");

  // Don't keep stale expanded notes hanging around when you leave Event Setup
  useEffect(() => {
    if (screen !== "marker_setup") setExpandedEventNotesId(null);
  }, [screen]);

  // And don't keep Next-list notes open when you leave Home.
  useEffect(() => {
    if (screen !== "home") setExpandedNextNotesId(null);
  }, [screen]);

  const [menuVisible, setMenuVisible] = useState(false);
  const menuT = useRef(new Animated.Value(0)).current;

  // Drawer motion + backdrop dim derived from menuT
  const drawerBackdropOp = useMemo(() => {
    return menuT.interpolate({ inputRange: [0, 1], outputRange: [0, 0.55] });
  }, [menuT]);

  const drawerX = useMemo(() => {
    // slide in from left; a little extra so shadow doesn’t peek when closed
    return menuT.interpolate({ inputRange: [0, 1], outputRange: [-DRAWER_W - 24, 0] });
  }, [menuT, DRAWER_W]);

  const defaultFolderT = useRef(new Animated.Value(0)).current;
  const customFolderT = useRef(new Animated.Value(0)).current;
  const repeatableFolderT = useRef(new Animated.Value(0)).current;
  const fishFolderT = useRef(new Animated.Value(0)).current;

  const [defaultMarkersOpen, setDefaultMarkersOpen] = useState(false);
  const [customMarkersOpen, setCustomMarkersOpen] = useState(false);
  const [repeatableMarkersOpen, setRepeatableMarkersOpen] = useState(false);
  const [fishMarkersOpen, setFishMarkersOpen] = useState(false);

  const [defaultMarkersSort, setDefaultMarkersSort] = useState<"time" | "next">("time");
  const [customMarkersSort, setCustomMarkersSort] = useState<"time" | "next">("time");
  const [repeatableMarkersSort, setRepeatableMarkersSort] = useState<"time" | "next">("time");
  const [fishMarkersSort, setFishMarkersSort] = useState<"time" | "next">("time");


  // Event Setup: tap an event row to reveal its notes underneath (simple dropdown)
  const [expandedEventNotesId, setExpandedEventNotesId] = useState<string | null>(null);

  // Next pill: gentle breathing pulse (opacity)
  const nextPillPulseT = useRef(new Animated.Value(1)).current;
  const nextPillPulse = nextPillPulseT;

  useEffect(() => {
    // Only pulse on Home when the *next* enabled marker is within the last minute.
    // Otherwise it turns into a needy little attention beacon.
    if (screen !== "home" || enabledMarkers.length === 0) {
      nextPillPulseT.stopAnimation();
      nextPillPulseT.setValue(1);
      return;
    }

    const first = enabledMarkers[0];
    const cd = Math.max(0, countdowns[first.id] ?? 0);
    const shouldPulse = cd > 0 && cd <= 60;

    if (!shouldPulse) {
      nextPillPulseT.stopAnimation();
      nextPillPulseT.setValue(1);
      return;
    }

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(nextPillPulseT, {
          toValue: 0.72,
          duration: 900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(nextPillPulseT, {
          toValue: 1,
          duration: 900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
      { resetBeforeIteration: true }
    );

    loop.start();
    return () => loop.stop();
  }, [screen, enabledMarkers, countdowns, nextPillPulseT]);

  // Enable LayoutAnimation on Android (old architecture only)
  // New Architecture: this is a no-op and logs a warning, so we skip it.
  useEffect(() => {
    if (Platform.OS !== "android") return;

    const pc = (NativeModules as any)?.PlatformConstants ?? {};
    const isFabric =
      pc.isFabric === true ||
      pc.fabricEnabled === true ||
      pc.FabricEnabled === true ||
      (global as any)?._IS_FABRIC === true ||
      (global as any)?.nativeFabricUIManager != null ||
      (global as any)?.RN$Bridgeless === true;

    if (isFabric) return;

    try {
      if (UIManager.setLayoutAnimationEnabledExperimental) {
        UIManager.setLayoutAnimationEnabledExperimental(true);
      }
    } catch {
      // If this explodes, we just don't enable it. Life goes on.
    }
  }, []);;

  // SECTION X) Android nav bar: hide while app is open (immersive)
  useEffect(() => {
    if (Platform.OS !== "android") return;

    const hideNav = async () => {
      try {
        // Edge-to-edge on Android disables some NavigationBar APIs (position/background),
        // so we only request "hidden" here to avoid warning spam.
        await NavigationBar.setVisibilityAsync("hidden");
      } catch {
        // If this fails on a device/ROM, we just don't hide it. Life goes on.
      }
    };

    hideNav();

    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") hideNav();
    });

    return () => {
      // RN 0.65+ style subscription
      // @ts-ignore
      if (sub?.remove) sub.remove();
      // @ts-ignore
      else if (typeof sub === "function") sub();
    };
  }, []);


  // Gentle “settle” animation (list reorder, folder rows appearing, etc.)
  const softLayoutNext = useCallback(() => {
    if (Platform.OS === "web") return; // web ignores LayoutAnimation
    LayoutAnimation.configureNext({
      duration: 240,
      update: { type: LayoutAnimation.Types.easeInEaseOut },
      create: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
      delete: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
    });
  }, []);

  // Optional: reroll the “extra” next-slot stars when the next slot changes.
  // Cozy “alive” feel, not chaos.
  useEffect(() => {
    if (!nextTimeKey) return;
    setStarSeedSalt((s) => (s + 1) % 1000000);
  }, [nextTimeKey]);

  const openMenu = useCallback(() => {
    // Stop any in-flight animation to avoid "judder" if the user taps quickly.
    menuT.stopAnimation();
    setMenuVisible(true);

    // Let the Modal mount first, then animate in.
    requestAnimationFrame(() => {
      Animated.timing(menuT, {
        toValue: 1,
        duration: 260,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    });
  }, [menuT]);

  const closeMenu = useCallback(() => {
    menuT.stopAnimation();
    Animated.timing(menuT, {
      toValue: 0,
      duration: 240,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(() => {
      setMenuVisible(false);
    });
  }, [menuT]);

  const goToMarkerSetup = useCallback(() => {
    closeMenu();
    requestAnimationFrame(() => setScreen("marker_setup"));
  }, [closeMenu]);

  const goToHome = useCallback(() => {
    closeMenu();
    requestAnimationFrame(() => setScreen("home"));
  }, [closeMenu]);

  // Folder open/close: slow-ish ease + slight fade/slide (cozy)
  const animateFolder = useCallback((t: Animated.Value, open: boolean) => {
    Animated.timing(t, {
      toValue: open ? 1 : 0,
      duration: open ? 260 : 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false, // animating maxHeight
    }).start();
  }, []);

  useEffect(() => animateFolder(defaultFolderT, defaultMarkersOpen), [defaultMarkersOpen, defaultFolderT, animateFolder]);
  useEffect(() => animateFolder(customFolderT, customMarkersOpen), [customMarkersOpen, customFolderT, animateFolder]);
  useEffect(() => animateFolder(repeatableFolderT, repeatableMarkersOpen), [repeatableMarkersOpen, repeatableFolderT, animateFolder]);
  useEffect(() => animateFolder(fishFolderT, fishMarkersOpen), [fishMarkersOpen, fishFolderT, animateFolder]);
  

  // Folder list viewport height
  // - Folder bodies are max-height clipped so the page doesn't become endless.
  // - The inner folder body uses its own (height-capped) ScrollView so users can reach everything.
  const FOLDER_BODY_MAX_H = useMemo(() => {
    // A comfy viewport: ~60% of screen, with sane bounds.
    return Math.min(720, Math.max(280, Math.floor(SCREEN_H * 0.62)));
  }, [SCREEN_H]);


  const folderBodyStyle = useCallback((t: Animated.Value) => {
    return {
      overflow: "hidden" as const,
      maxHeight: t.interpolate({ inputRange: [0, 1], outputRange: [0, FOLDER_BODY_MAX_H] }),
      opacity: t.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }),
      transform: [{ translateY: t.interpolate({ inputRange: [0, 1], outputRange: [-6, 0] }) }],
    };
  }, [FOLDER_BODY_MAX_H]);


  // Folder toggles: settle
  const toggleDefaultFolder = useCallback(() => {
    softLayoutNext();
    setDefaultMarkersOpen((v) => !v);
  }, [softLayoutNext]);

  const toggleCustomFolder = useCallback(() => {
    softLayoutNext();
    setCustomMarkersOpen((v) => !v);
  }, [softLayoutNext]);

  const toggleRepeatableFolder = useCallback(() => {
    softLayoutNext();
    setRepeatableMarkersOpen((v) => !v);
  }, [softLayoutNext]);

  const toggleFishFolder = useCallback(() => {
    softLayoutNext();
    setFishMarkersOpen((v) => !v);
  }, [softLayoutNext]);


  // Sort toggles: small “settling” animation via LayoutAnimation
  const toggleDefaultSort = useCallback(() => {
    softLayoutNext();
    setDefaultMarkersSort((s) => (s === "time" ? "next" : "time"));
  }, [softLayoutNext]);

  const toggleCustomSort = useCallback(() => {
    softLayoutNext();
    setCustomMarkersSort((s) => (s === "time" ? "next" : "time"));
  }, [softLayoutNext]);

  const toggleRepeatableSort = useCallback(() => {
    softLayoutNext();
    setRepeatableMarkersSort((s) => (s === "time" ? "next" : "time"));
  }, [softLayoutNext]);

  const toggleFishSort = useCallback(() => {
    softLayoutNext();
    setFishMarkersSort((s) => (s === "time" ? "next" : "time"));
  }, [softLayoutNext]);


// SECTION 19.2) Render

  return (
    <View style={styles.root}>
      <BackgroundSparkles />

      


{/* Closed Test notice (shown once) */}
<Modal
  visible={closedTestOpen}
  transparent
  animationType="fade"
  statusBarTranslucent
  onRequestClose={dismissClosedTest}
>
  <View style={styles.ctBackdrop}>
    {Platform.OS === "android" ? (
      <BlurView experimentalBlurMethod="dimezisBlurView" intensity={22} tint="dark" style={StyleSheet.absoluteFill} />
    ) : (
      <BlurView intensity={22} tint="dark" style={StyleSheet.absoluteFill} />
    )}
    <Pressable style={styles.ctBackdropPress} onPress={dismissClosedTest} />

    <View style={styles.ctCard}>
      <Text style={styles.ctTitle}>Closed Test Build</Text>
      <Text style={styles.ctText}>Features may be incomplete or change.</Text>
      <Text style={styles.ctText}>
        If something feels off, use <Text style={styles.ctTextStrong}>Send feedback</Text> in Settings.
      </Text>

      <View style={styles.ctBtnRow}>
        <Pressable onPress={dismissClosedTest} style={styles.ctBtn}>
          <Text style={styles.ctBtnText}>Got it</Text>
        </Pressable>
      </View>
    </View>
  </View>
</Modal>
<ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
{/* SECTION 19.3) Header */}

        <View style={styles.headerRow}>
          {screen === "home" ? (
            <Pressable onPress={openMenu} style={styles.menuBtn} hitSlop={12}>
              <Ionicons name="menu-outline" size={22} color={SOFT_WHITE} />
            </Pressable>
          ) : (
            <Pressable
              onPress={() => {
                resetForm();
                setScreen("home");
              }}
              style={styles.menuBtn}
              hitSlop={12}
            >
              <Ionicons name="arrow-back" size={22} color={SOFT_WHITE} />
            </Pressable>
          )}

          <View style={styles.titleCard}>
            <Text style={styles.screenTitle}>
              {screen === "home" ? "Palia Event Tracker" : "Event Setup"}
            </Text>
          </View>

          <Pressable onPress={() => setSetupOpen(true)} style={styles.cogBtn} hitSlop={12}>
            <Ionicons name="settings-outline" size={22} color={SOFT_WHITE} />
          </Pressable>
        </View>


{/* SECTION 19.3.X) Home banners */}

        {screen === "home" ? (
          <View style={{ marginBottom: 12 }}
            pointerEvents="box-none"
          >
            {/* What's New banner (persist dismissal across restarts) */}
            {!whatsNewDismissed ? (
              <View style={styles.bannerCard}>
                <View style={styles.bannerLeft}>
                  <Text style={styles.bannerKicker}>WHAT’S NEW</Text>
{WHATS_NEW_ITEMS.map((t, i) => (
  <Text key={`wn_${i}`} style={styles.bannerBullet}>
    • {t}
  </Text>
))}
<Text style={styles.bannerSubGold}>- Dismiss hides this until the next update.</Text>
                </View>

                <Pressable
                  onPress={async () => {
                    bannerXGuardRef.current = true;
                    setWhatsNewDismissed(true);
                    try {
                      await AsyncStorage.setItem(STORAGE_WHATSNEW_DISMISSED_ID, WHATS_NEW_ID);
                    } catch {
                      // ignore
                    }
                  }}
                  hitSlop={10}
                  style={({ pressed }) => [styles.bannerX, pressed && { opacity: 0.75 }]}
                >
                  <Ionicons name="close" size={18} color={SOFT_WHITE} />
                </Pressable>
              </View>
            ) : null}

            {/* Notifications OFF banner (session-dismiss, re-shows on reopen) */}
            {Platform.OS !== "web" && !notifEnabled && !notifBannerDismissed ? (
              <Pressable
                onPress={() => {
                  if (bannerXGuardRef.current) {
                    bannerXGuardRef.current = false;
                    return;
                  }
                  setSetupOpen(true);
                }}
                style={({ pressed }) => [
                  styles.bannerCard,
                  pressed && { opacity: 0.92, transform: [{ scale: 0.995 }] },
                ]}
              >
                <View style={styles.bannerLeft}>
                  <Text style={styles.bannerKicker}>NOTIFICATIONS</Text>
                  <Text style={styles.bannerBullet}>Notifications are currently off. Tap to open 'Settings' to enable reminders.</Text>
                </View>

                <Pressable
                  onPress={() => {
                    bannerXGuardRef.current = true;
                    setNotifBannerDismissed(true);
                  }}
                  hitSlop={10}
                  style={({ pressed }) => [styles.bannerX, pressed && { opacity: 0.75 }]}
                >
                  <Ionicons name="close" size={18} color={SOFT_WHITE} />
                </Pressable>
              </Pressable>
            ) : null}
          </View>
        ) : null}

{/* SECTION 19.4) Clock card */}

        {screen === "home" ? (
          <View style={[styles.card, styles.cardClock]}>
            <View style={styles.clockLabelRow}>
              <View style={styles.clockLabelLeft}>
                <Pressable
                  onPress={() => setRotateClock((v) => !v)}
                  style={[styles.clockIconBtn, rotateClock && styles.rotateBtnOn]}
                  hitSlop={10}
                >
                  <Ionicons name="time-outline" size={16} color={rotateClock ? ACCENT : SOFT_WHITE} />
                </Pressable>
              </View>
              <Text style={styles.clockLabel}>PALIAN TIME</Text>
              <View style={styles.clockLabelActions}>
                <Pressable
                  onPress={manualResyncNotifications}
                  disabled={refreshCoolingDown}
                  hitSlop={10}
                  style={({ pressed }) => [
                    styles.clockIconBtn,
                    refreshCoolingDown && { opacity: 0.35 },
                    pressed && !refreshCoolingDown && { opacity: 0.75 },
                  ]}
                >
                  <Ionicons name="refresh" size={16} color={SOFT_WHITE} />
                </Pressable>
              </View>


            </View>

            <View style={styles.clockWrap}>
              <PaliaClockFace
                paliaHour={paliaTime.hour}
                paliaMinute={paliaTime.minute}
                markers={enabledMarkers}
                nextTimeKey={nextTimeKey}
                rotateClock={rotateClock}
                starSeedSalt={starSeedSalt}
              />
            </View>

            {/* Clock view switcher (sits under the clock, not on top of it) */}
            <View style={styles.clockViewRow}>
              <View style={[styles.clockViewGroup, clockViewOpen && styles.clockViewGroupOpen]}>
                <Pressable
                  onPress={() => setClockViewOpen((v) => !v)}
                  hitSlop={10}
                  style={({ pressed }) => [
                    styles.clockViewEyeBtn,
                    clockViewOpen && styles.clockViewEyeBtnOpen,
                    pressed && { opacity: 0.78 },
                  ]}
                >
                  <Ionicons name="eye-outline" size={16} color={SOFT_WHITE} />
                </Pressable>

                {clockViewOpen ? (
                  <View style={styles.clockViewOptions}>
                    {([
                      { key: "events", label: "Events" },
                      { key: "fish", label: "Fish" },
                      { key: "bugs", label: "Bugs" },
                    ] as const).map((it) => {
                      const active = clockViewMode === it.key;
                      return (
                        <Pressable
                          key={it.key}
                          onPress={() => setClockViewMode(it.key)}
                          style={[styles.clockViewOptionItem, active && styles.clockViewOptionItemOn]}
                          hitSlop={6}
                        >
                          <Text
                            style={[styles.clockViewOptionText, active && styles.clockViewOptionTextOn]}
                          >
                            {it.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                ) : null}
              </View>
            </View>

            <View style={styles.timeOfDayRow}>
              {([
                { key: "morning", label: "Morning" },
                { key: "day", label: "Day" },
                { key: "evening", label: "Evening" },
                { key: "night", label: "Night" },
              ] as const).map((it, idx) => {
                const filterOn = nextTimeFilter != null;
                const selected = nextTimeFilter === it.key;
                const showActive = !filterOn && activeTimeOfDay === it.key;

                return (
                  <React.Fragment key={it.key}>
                    <Pressable
                      onPress={() =>
                        setNextTimeFilter((prev) => (prev === it.key ? null : it.key))
                      }
                      style={[
                        styles.timeOfDayChip,
                        selected && styles.timeOfDayChipOn,
                      ]}
                      hitSlop={6}
                    >
                      <Text
                        style={[
                          styles.timeOfDayText,
                          showActive && styles.timeOfDayTextActive,
                          selected && styles.timeOfDayTextActive,
                        ]}
                      >
                        {it.label}
                      </Text>
                    </Pressable>

                    {idx < 3 ? <Text style={styles.timeOfDayDot}>•</Text> : null}
                  </React.Fragment>
                );
              })}
            </View>

            <View style={styles.nextCard}>
              <View style={styles.nextHeaderRow}>
                <View style={styles.nextHeaderLeft}>
                  <Text style={styles.nextTitle}>Now</Text>
                  <Text style={styles.nextMeta}>
                    {nowItems.length ? `${nowItems.length} active` : "—"}
                  </Text>
                </View>

                <View style={styles.nextHeaderRight}>
                  {nowSoonest ? (
                    <View style={[styles.nextPill, { opacity: 1 }]}>
                      <Text style={styles.nextPillText}>Ends in {formatCountdown(nowSoonestEndsInSec)}</Text>
                    </View>
                  ) : (
                    <View style={[styles.nextPill, { opacity: 1 }]}>
                      <Text style={styles.nextPillText}>{paliaTime.formatted12}</Text>
                    </View>
                  )}
                </View>
              </View>

              {nowSoonest ? (
                <View style={styles.nowCountdownWrap}>
                  <View style={styles.nowBarRow}>
                    <Ionicons name="star" size={14} color={ACCENT} />
                    <View style={styles.nowProgressTrack}>
                      <View style={[styles.nowProgressFill, { width: `${Math.round(nowSoonestFrac * 100)}%` }]} />
                    </View>
                  </View>
                </View>
              ) : null}

              {nowItems.length ? (
                clockViewMode === "fish" ? (
                  <View style={styles.fishGrid}>
                    {nowItems.map((it) => {
                      const marker = markers.find((m) => m.id === it.id);
                      const notesOpen = expandedNowNotesId === it.id;

                      return (
                        <View key={`nowfish-${it.id}`} style={styles.fishCell}>
                          <Pressable
                            onPress={() => {
                              if (nextCardGuardRef.current) {
                                nextCardGuardRef.current = false;
                                return;
                              }
                              setExpandedNowNotesId((prev) => (prev === it.id ? null : it.id));
                            }}
                            style={({ pressed }) => [
                              styles.fishCard,
                              pressed && { opacity: 0.92, transform: [{ scale: 0.99 }] },
                            ]}
                            android_ripple={{ color: "rgba(255,255,255,0.06)" }}
                          >
                            <View style={styles.fishCardInner}>
                              <View style={styles.fishTopRow}>
                                <View style={styles.fishImageSlot}>
                                  {marker?.imageUrl ? (
                                    <Image source={{ uri: marker.imageUrl }} style={styles.fishImage} />
                                  ) : null}
                                </View>

                                <ScalePressable
                                  onPress={() => {
                                    nextCardGuardRef.current = true;
                                    if (!marker) return;
                                    toggleNotify(marker.id);
                                  }}
                                  style={styles.fishBellBtn}
                                >
                                  <Ionicons
                                    name={marker?.notify ? "notifications-outline" : "notifications-off-outline"}
                                    size={16}
                                    color={marker?.notify ? ACCENT : SOFT_WHITE_DIM}
                                  />
                                </ScalePressable>
                              </View>

                              <View style={styles.fishBottomBlock}>
                                <Text style={styles.fishTitle} numberOfLines={2}>
                                  {it.eventName}
                                </Text>

                                {it.location ? (
                                  <Text style={styles.fishSub} numberOfLines={1}>
                                    {it.location}
                                  </Text>
                                ) : null}

                                <View style={styles.fishMetaRow}>
                                  <Text style={styles.fishMetaText} numberOfLines={2}>
                                    {"Ends\n"}{format12hTime(it.endHour, it.endMinute)}
                                  </Text>
                                </View>
                              </View>
                            </View>
                          </Pressable>

                          {notesOpen ? (
                            <View style={styles.eventNotesDrop}>
                              <Text style={styles.eventNotesLabel}>Notes</Text>
                              <Text style={styles.eventNotesText}>
                                {String(marker?.notes ?? "").trim().length > 0
                                  ? String(marker?.notes).trim()
                                  : "No notes yet."}
                              </Text>
                            </View>
                          ) : null}
                        </View>
                      );
                    })}
                  </View>
                ) : (
                  <View style={styles.nextList}>
                    {nowItems.map((it) => {
                      const marker = markers.find((m) => m.id === it.id);
                      const notesOpen = expandedNowNotesId === it.id;

                      return (
                        <View key={`now-${it.id}`} style={{ marginBottom: 10 }}>
                          <Pressable
                            onPress={() => {
                              // Tap = quick notes dropdown (match the "Next" UX)
                              if (nextCardGuardRef.current) {
                                nextCardGuardRef.current = false;
                                return;
                              }
                              setExpandedNowNotesId((prev) => (prev === it.id ? null : it.id));
                            }}
                            style={({ pressed }) => [
                              styles.nextRow,
                              pressed && { opacity: 0.92, transform: [{ scale: 0.995 }] },
                            ]}
                            android_ripple={{ color: "rgba(255,255,255,0.06)" }}
                          >
                            <View style={styles.nextIconWrap}>
                              {(() => {
                                const isSoonestEnd =
                                  !!nowSoonestKey && `${it.endHour}:${it.endMinute}` === nowSoonestKey;
                                return (
                                  <MaterialIcons
                                    name={it.location ? "place" : "eco"}
                                    size={14}
                                    color={isSoonestEnd ? ACCENT : "rgba(252,248,240,0.86)"}
                                  />
                                );
                              })()}
                            </View>

                            <View style={styles.nextRowTextCol}>
                              <Text style={styles.nextRowTitle} numberOfLines={1}>
                                {it.eventName}
                              </Text>
                              {it.location ? (
                                <Text style={styles.nextRowSub} numberOfLines={1}>
                                  {it.location}
                                </Text>
                              ) : null}
                            </View>

                            <View style={styles.nowRightRow}>
                              <ScalePressable
                                onPress={() => {
                                  nextCardGuardRef.current = true;
                                  if (!marker) return;
                                  toggleNotify(marker.id);
                                }}
                                style={styles.nowBellChip}
                              >
                                <Ionicons
                                  name={marker?.notify ? "notifications-outline" : "notifications-off-outline"}
                                  size={18}
                                  color={marker?.notify ? ACCENT : SOFT_WHITE_DIM}
                                />
                              </ScalePressable>
                            </View>
                          </Pressable>

                          {notesOpen ? (
                            <View style={styles.eventNotesDrop}>
                              <Text style={styles.eventNotesLabel}>Notes</Text>
                              <Text style={styles.eventNotesText}>
                                {String(marker?.notes ?? "").trim().length > 0
                                  ? String(marker?.notes).trim()
                                  : "No notes yet."}
                              </Text>
                            </View>
                          ) : null}
                        </View>
                      );
                    })}
                  </View>
                )
              ) : (
                <Text style={[styles.nextEmpty, { marginTop: 8 }]}>No active events</Text>
              )}
            </View>

            <View style={styles.nextCard}>
              <View style={styles.nextHeaderRow}>
                <View style={styles.nextHeaderLeft}>
                  <Text style={styles.nextTitle}>Next</Text>
                  <Text style={styles.nextMeta}>{nextTimeFilter ? `All ${nextTimeFilter.charAt(0).toUpperCase() + nextTimeFilter.slice(1)} events` : nextDigitalLabel}</Text>
                </View>

                                <View style={styles.nextHeaderRight}>
                  {!nextTimeFilter && enabledMarkers.length ? (
                    <Animated.View style={[styles.nextPill, { opacity: nextPillPulse }]}>
                      <Text style={styles.nextPillText}>{nextCountdownLabel}</Text>
                    </Animated.View>
                  ) : null}

                  {!nextTimeFilter ? (
                  <View style={styles.nextCountSegment}>
                                      {[1, 2, 3].map((n) => {
                                        const active = nextTimeCount === n;
                                        return (
                                          <Pressable
                                            key={n}
                                            onPress={() => setNextTimeCount(n as 1 | 2 | 3)}
                                            style={[
                                              styles.nextCountSegmentItem,
                                              active && styles.nextCountSegmentItemOn,
                                            ]}
                                          >
                                            <Text
                                              style={[
                                                styles.nextCountSegmentText,
                                                active && styles.nextCountSegmentTextOn,
                                              ]}
                                            >
                                              {n}
                                            </Text>
                                          </Pressable>
                                        );
                                      })}
                                    </View>
                                  
                ) : null}</View>
              </View>

              {clockViewMode === "fish" ? (
                homeListMarkers.length ? (
                  <View style={styles.fishGrid}>
                    {homeListMarkers.map((m) => {
                      const marker = markers.find((x) => x.id === m.id);
                      const notesOpen = expandedNextNotesId === m.id;
                      const { eventName, location } = splitName(m.name);

                      return (
                        <View key={`nextfish-${m.id}`} style={styles.fishCell}>
                          <Pressable
                            onPress={() => {
                              if (nextCardGuardRef.current) {
                                nextCardGuardRef.current = false;
                                return;
                              }
                              setExpandedNextNotesId((prev) => (prev === m.id ? null : m.id));
                            }}
                            style={({ pressed }) => [
                              styles.fishCard,
                              pressed && { opacity: 0.92, transform: [{ scale: 0.99 }] },
                            ]}
                            android_ripple={{ color: "rgba(255,255,255,0.06)" }}
                          >
                            <View style={styles.fishCardInner}>
                              <View style={styles.fishTopRow}>
                                <View style={styles.fishImageSlot}>
                                  {marker?.imageUrl ? (
                                    <Image source={{ uri: marker.imageUrl }} style={styles.fishImage} />
                                  ) : null}
                                </View>

                                <ScalePressable
                                  onPress={() => {
                                    nextCardGuardRef.current = true;
                                    if (!marker) return;
                                    toggleNotify(marker.id);
                                  }}
                                  style={styles.fishBellBtn}
                                >
                                  <Ionicons
                                    name={marker?.notify ? "notifications-outline" : "notifications-off-outline"}
                                    size={16}
                                    color={marker?.notify ? ACCENT : SOFT_WHITE_DIM}
                                  />
                                </ScalePressable>
                              </View>

                              <View style={styles.fishBottomBlock}>
                                <Text style={styles.fishTitle} numberOfLines={2}>
                                  {eventName}
                                </Text>

                                {location ? (
                                  <Text style={styles.fishSub} numberOfLines={1}>
                                    {location}
                                  </Text>
                                ) : null}

                                <View style={styles.fishMetaRow}>
                                  <Text style={styles.fishMetaText} numberOfLines={1}>
                                    {format12hTime(m.hour, m.minute)}
                                  </Text>
                                </View>
                              </View>
                            </View>
                          </Pressable>

                          {notesOpen ? (
                            <View style={styles.eventNotesDrop}>
                              <Text style={styles.eventNotesLabel}>Notes</Text>
                              <Text style={styles.eventNotesText}>
                                {String(marker?.notes ?? "").trim().length > 0
                                  ? String(marker?.notes).trim()
                                  : "No notes yet."}
                              </Text>
                            </View>
                          ) : null}
                        </View>
                      );
                    })}
                  </View>
                ) : (
                  <Text style={[styles.nextEmpty, { marginTop: 8 }]}>No enabled events</Text>
                )
              ) : nextTimeGroups.length ? (
                <View style={styles.nextList}>
                  {(nextTimeFilter ? nextTimeGroups : nextTimeGroups.slice(0, nextTimeCount)).map((group) => (
                    <View key={`ntg-${group.timeKey}`} style={styles.nextGroup}>
                      <Text style={styles.nextGroupHeader}>
                        {group.timeLabel} · {group.items.length} event{group.items.length !== 1 ? "s" : ""}
                      </Text>

                      {group.items.map((it) => {
                        const marker = markers.find((m) => m.id === it.id);
                        const notesOpen = expandedNextNotesId === it.id;

                        return (
                          <View key={`nti-${it.id}`} style={{ marginBottom: 10 }}>
                            <Pressable
                              onPress={() => {
                                if (nextCardGuardRef.current) {
                                  nextCardGuardRef.current = false;
                                  return;
                                }
                                // Tap = quick notes dropdown (same UX as Event Setup)
                                setExpandedNextNotesId((prev) => (prev === it.id ? null : it.id));
                              }}
                              style={({ pressed }) => [
                                styles.nextRow,
                                pressed && { opacity: 0.92, transform: [{ scale: 0.995 }] },
                              ]}
                              android_ripple={{ color: "rgba(255,255,255,0.06)" }}
                            >
                              <View style={styles.nextIconWrap}>
                                <MaterialIcons
                                  name={it.location ? "place" : "eco"}
                                  size={14}
                                  color="rgba(252,248,240,0.86)"
                                />
                              </View>

                              <View style={styles.nextRowTextCol}>
                                <Text style={styles.nextRowTitle} numberOfLines={1}>
                                  {it.eventName}
                                </Text>
                                {it.location ? (
                                  <Text style={styles.nextRowSub} numberOfLines={1}>
                                    {it.location}
                                  </Text>
                                ) : null}
                              </View>


                              <View style={styles.nextRowRight}>
                                <ScalePressable
                                  onPress={() => {
                                    nextCardGuardRef.current = true;
                                    if (!marker) return;
                                    toggleNotify(marker.id);
                                  }}
                                  style={styles.nextBellChip}
                                >
                                  <Ionicons
                                    name={marker?.notify ? "notifications-outline" : "notifications-off-outline"}
                                    size={18}
                                    color={marker?.notify ? ACCENT : SOFT_WHITE_DIM}
                                  />
                                </ScalePressable>
                              </View>
                            </Pressable>

                            {notesOpen ? (
                              <View style={styles.eventNotesDrop}>
                                <Text style={styles.eventNotesLabel}>Notes</Text>
                                <Text style={styles.eventNotesText}>
                                  {String(marker?.notes ?? "").trim().length > 0
                                    ? String(marker?.notes).trim()
                                    : "No notes yet."}
                                </Text>
                              </View>
                            ) : null}
                          </View>
                        );
                      })}
                    </View>
                  ))}
                </View>
              ) : (
                <Text style={[styles.nextEmpty, { marginTop: 8 }]}>No enabled events</Text>
              )}

              <Pressable
                onPress={() => setScreen("marker_setup")}
                style={({ pressed }) => [
                  styles.nextSetupBtn,
                  pressed && { opacity: 0.85, transform: [{ scale: 0.99 }] },
                ]}
              >
                <Text style={styles.nextSetupBtnText}>Event Setup</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

{/* SECTION 19.5) Real time card */}

        {screen === "home" ? (
          <View style={[styles.card, styles.cardReal]}>
            <RealTimeCard  textScale={textScale}/>
          </View>
        ) : null}

{/* SECTION 19.6) Add/Edit card  (Marker Setup screen) */}

{screen === "marker_setup" ? (
  <View style={styles.card}>
    {(() => {
      const isOpen = addMarkerOpen || !!editingId;

      const HOURS = Array.from({ length: 24 }, (_, i) => i);
      const MINUTES = Array.from({ length: 60 }, (_, i) => i);

      const isDefaultEdit = !!editingId && editingId.startsWith("default_");
      const allowBlankLocation = isDefaultEdit;

      // Folder options (future proof). For now: only Custom is available for NEW markers.
      // Includes a disabled placeholder so humans stop asking where the other folders are.
      const FOLDER_ITEMS: { label: string; value: "custom" | null; disabled?: boolean }[] = [
        { label: "Custom Events", value: "custom" },
        { label: "More folders coming soon...", value: null, disabled: true },
      ];

      const canPickFolder = !editingId; // only for creating new markers (no moving/editing folders yet)

      // Location options (in the order you demanded)
      type LocItem = { label: string; value: string; kind: "top" | "sub" };

      const LOCATION_ITEMS_BASE: LocItem[] = [
        { label: "Home Plot", value: "Home Plot", kind: "top" },
        { label: "Friends Plot", value: "Friends Plot", kind: "top" },

        { label: "Kilima Valley", value: "Kilima Valley", kind: "top" },
        { label: "K - Chapaa Crossing", value: "K - Chapaa Crossing", kind: "sub" },
        { label: "K - Fisherman's Lagoon", value: "K - Fisherman's Lagoon", kind: "sub" },
        { label: "K - Gillyfin Cove", value: "K - Gillyfin Cove", kind: "sub" },
        { label: "K - Kilima Village", value: "K - Kilima Village", kind: "sub" },
        { label: "K - Leafhopper Hills", value: "K - Leafhopper Hills", kind: "sub" },
        { label: "K - Maji's Hollow", value: "K - Maji's Hollow", kind: "sub" },
        { label: "K - Mayor's Estate", value: "K - Mayor's Estate", kind: "sub" },
        { label: "K - Mirror Fields", value: "K - Mirror Fields", kind: "sub" },
        { label: "K - Mirror Pond Ruins", value: "K - Mirror Pond Ruins", kind: "sub" },
        { label: "K - Phoenix Falls", value: "K - Phoenix Falls", kind: "sub" },
        { label: "K - Reflection Fields", value: "K - Reflection Fields", kind: "sub" },
        { label: "K - Remembrance Beach", value: "K - Remembrance Beach", kind: "sub" },
        { label: "K - Remembrance Garden", value: "K - Remembrance Garden", kind: "sub" },
        { label: "K - Underground", value: "K - Underground", kind: "sub" },
        { label: "K - Whispering Banks", value: "K - Whispering Banks", kind: "sub" },

        { label: "Bahari Bay", value: "Bahari Bay", kind: "top" },
        { label: "B - Ancient Aqueduct", value: "B - Ancient Aqueduct", kind: "sub" },
        { label: "B - Beachcomber Cove", value: "B - Beachcomber Cove", kind: "sub" },
        { label: "B - Coral Shores", value: "B - Coral Shores", kind: "sub" },
        { label: "B - Flooded Fortress", value: "B - Flooded Fortress", kind: "sub" },
        { label: "B - Flooded Steps", value: "B - Flooded Steps", kind: "sub" },
        { label: "B - Hideaway Bluffs", value: "B - Hideaway Bluffs", kind: "sub" },
        { label: "B - Lighthouse Lagoon", value: "B - Lighthouse Lagoon", kind: "sub" },
        { label: "B - Pavel Mines", value: "B - Pavel Mines", kind: "sub" },
        { label: "B - Proudhorn Pass", value: "B - Proudhorn Pass", kind: "sub" },
        { label: "B - Pulsewater Plains", value: "B - Pulsewater Plains", kind: "sub" },
        { label: "B - Statue Garden", value: "B - Statue Garden", kind: "sub" },
        { label: "B - The Outskirts", value: "B - The Outskirts", kind: "sub" },
        { label: "B - Thorny Thicket", value: "B - Thorny Thicket", kind: "sub" },
        { label: "B - Windy Ruins", value: "B - Windy Ruins", kind: "sub" },

        { label: "Elderwood", value: "Elderwood", kind: "top" },
        { label: "E - Central Stables", value: "E - Central Stables", kind: "sub" },
        { label: "E - Mitana Grove", value: "E - Mitana Grove", kind: "sub" },
        { label: "E - Honeymiel Slope", value: "E - Honeymiel Slope", kind: "sub" },
        { label: "E - Lilac Cavern", value: "E - Lilac Cavern", kind: "sub" },
        { label: "E - Jeunesse Pass", value: "E - Jeunesse Pass", kind: "sub" },
        { label: "E - Deep Woods", value: "E - Deep Woods", kind: "sub" },
        { label: "E - The Fallen Aqueduct", value: "E - The Fallen Aqueduct", kind: "sub" },
        { label: "E - Red Blossom Cave", value: "E - Red Blossom Cave", kind: "sub" },
        { label: "E - Okanaa Bog", value: "E - Okanaa Bog", kind: "sub" },
        { label: "E - De Mer Dock", value: "E - De Mer Dock", kind: "sub" },
        { label: "E - Vieuxport Sea", value: "E - Vieuxport Sea", kind: "sub" },
        { label: "E - Mauvais Way", value: "E - Mauvais Way", kind: "sub" },
        { label: "E - Zendruu Way", value: "E - Zendruu Way", kind: "sub" },
      ];

      const LOCATION_ITEMS: LocItem[] = LOCATION_ITEMS_BASE;

      const ITEM_H = 38;
      const VISIBLE = 7;

      const wheelHeight = ITEM_H * VISIBLE;
      const wheelCenterTop = Math.floor(VISIBLE / 2) * ITEM_H;

      // ---------- Wheel snapping (Android-safe) ----------
      type WheelKey = "hour" | "minute" | "endHour" | "endMinute" | "location";

      const clearWheelTimer = (key: WheelKey) => {
        const t = wheelTimeoutRef.current[key];
        if (t) clearTimeout(t);
        wheelTimeoutRef.current[key] = undefined;
      };

      const clampIdx = (idx: number, len: number) => Math.max(0, Math.min(len - 1, idx));

      // Hard snap: NO animated scroll (prevents event-loop freezes), plus lock to prevent re-entrancy.
      const hardSnapAndPick = <T,>(
        key: WheelKey,
        y: number,
        items: readonly T[],
        onPick: (item: T, idx: number) => void,
        ref: any
      ) => {
        const idx = clampIdx(Math.round(y / ITEM_H), items.length);
        const ySnap = idx * ITEM_H;

        // If we're already snapping programmatically, ignore extra end-events.
        if (wheelSnapLockRef.current[key]) {
          onPick(items[idx], idx);
          return;
        }

        wheelSnapLockRef.current[key] = true;

        const drift = Math.abs(y - ySnap);
        const idxChanged = wheelLastSnapIdxRef.current[key] !== idx;
        wheelLastSnapIdxRef.current[key] = idx;

        requestAnimationFrame(() => {
          // Only correct if needed (prevents pointless work).
          if (drift > 0.5 || idxChanged) {
            ref?.current?.scrollTo?.({ y: ySnap, animated: false });
          }
          wheelSnapLockRef.current[key] = false;
        });

        onPick(items[idx], idx);
      };

      const wheelHandlers = <T,>(
        key: WheelKey,
        items: readonly T[],
        onPick: (item: T, idx: number) => void,
        ref: any
      ) => ({
        scrollEventThrottle: 16,
        onScroll: (e: any) => {
          if (Platform.OS !== "web") return;
          // Web often doesn't emit momentum events consistently, so we idle-snap after scrolling stops.
          clearWheelTimer(key);
          const y = e?.nativeEvent?.contentOffset?.y ?? 0;
          wheelTimeoutRef.current[key] = setTimeout(() => {
            hardSnapAndPick(key, y, items, onPick, ref);
          }, 90);
        },

        onScrollBeginDrag: () => {
          clearWheelTimer(key);
          wheelMomentumRef.current[key] = false;
        },
        onMomentumScrollBegin: () => {
          clearWheelTimer(key);
          wheelMomentumRef.current[key] = true;
        },
        onScrollEndDrag: (e: any) => {
          // If momentum doesn't start, Android may never fire momentum end.
          // So we schedule a tiny fallback snap.
          clearWheelTimer(key);
          const y = e?.nativeEvent?.contentOffset?.y ?? 0;

          wheelTimeoutRef.current[key] = setTimeout(() => {
            if (!wheelMomentumRef.current[key]) {
              hardSnapAndPick(key, y, items, onPick, ref);
            }
            wheelMomentumRef.current[key] = false;
          }, 80);
        },
        onMomentumScrollEnd: (e: any) => {
          clearWheelTimer(key);
          wheelMomentumRef.current[key] = false;

          const y = e?.nativeEvent?.contentOffset?.y ?? 0;
          hardSnapAndPick(key, y, items, onPick, ref);
        },
      });

      const renderWheel = (
        key: "hour" | "minute" | "endHour" | "endMinute",
        items: number[],
        value: number,
        onPick: (n: number) => void,
        ghost: boolean,
        scrollRef: any
      ) => {
        const selectedIdx = clampIdx(value, items.length);

        return (
          <View style={[styles.timeWheel, { height: wheelHeight }]}>
            <ScrollView
              ref={scrollRef}
              showsVerticalScrollIndicator={false}
              nestedScrollEnabled
              decelerationRate="fast"
              snapToInterval={ITEM_H}
              snapToAlignment="start"
              overScrollMode="never"
              contentContainerStyle={{ paddingVertical: wheelCenterTop }}
              onLayout={() => {
                requestAnimationFrame(() => {
                  wheelLastSnapIdxRef.current[key] = selectedIdx;
                  scrollRef?.current?.scrollTo?.({ y: selectedIdx * ITEM_H, animated: false });
                });
              }}
              {...wheelHandlers<number>(key, items, (pick) => onPick(pick), scrollRef)}
            >
              {items.map((n) => {
                const on = n === value;
                return (
                  <View key={`wheel-${key}-${n}`} style={[styles.timeWheelRow, { height: ITEM_H }]}>
                    <Text style={[styles.timeWheelText, on && styles.timeWheelTextOn]}>{pad2(n)}</Text>
                  </View>
                );
              })}
            </ScrollView>

            <View
              pointerEvents="none"
              style={[
                styles.timeWheelHighlight,
                ghost && styles.timeWheelHighlightGhost,
                { top: wheelCenterTop, height: ITEM_H },
              ]}
            />
          </View>
        );
      };

      const renderLocationWheel = () => {
        const selectedIdx = Math.max(0, LOCATION_ITEMS.findIndex((it) => it.value === newLocation));

        return (
          <View style={[styles.timeWheel, { height: wheelHeight }]}>
            <ScrollView
              scrollEnabled
              style={{ height: wheelHeight }}
              ref={locationWheelRef}
              showsVerticalScrollIndicator={false}
              nestedScrollEnabled
              decelerationRate="fast"
              snapToInterval={ITEM_H}
              snapToAlignment="start"
              overScrollMode="never"
              contentContainerStyle={{ paddingVertical: wheelCenterTop }}
              onLayout={() => {
                requestAnimationFrame(() => {
                  wheelLastSnapIdxRef.current.location = selectedIdx;
                  locationWheelRef?.current?.scrollTo?.({ y: selectedIdx * ITEM_H, animated: false });
                });
              }}
              {...wheelHandlers<LocItem>(
                "location",
                LOCATION_ITEMS,
                (it, idx) => {
                  // "top" and "sub" entries are selectable locations (e.g., Home Plot, Bahari Bay, plus sub-areas).
                  if (it.kind !== "top" && it.kind !== "sub") return;

                  setNewLocation(it.value);
                  setLocationTouched(true);

                  // Keep the wheel index in sync (useful for web where events can be inconsistent)
                  wheelLastSnapIdxRef.current.location = idx;
                },
                locationWheelRef
              )}
            >
              {LOCATION_ITEMS.map((it, idx) => {
                const on = it.value === newLocation;
                return (
                  <Pressable
                    key={`loc-${it.value}-${idx}`}
                    onPress={() => {
                      if (Platform.OS !== "web") return;
                      if (it.kind !== "sub" && it.kind !== "top") return;
                      // Commit immediately on web clicks (scroll momentum isn't guaranteed).
                      wheelLastSnapIdxRef.current.location = idx;
                      locationWheelRef?.current?.scrollTo?.({ y: idx * ITEM_H, animated: false });
                      setNewLocation(it.value);
                      setLocationTouched(true);
                    }}
                    style={({ pressed }) => [
                      styles.timeWheelRow,
                      styles.locationOptRow,
                      
                      { height: ITEM_H },
                      pressed && Platform.OS === "web" && (it.kind === "sub" || it.kind === "top") ? { opacity: 0.85 } : null,
                    ]}>
                  
                    <Text
                      style={[
                        styles.timeWheelText,
                        styles.locationOptText,
                        it.kind === "sub" && styles.locationSubText,
                        on && styles.timeWheelTextOn,                      ]}
                      numberOfLines={1}
                    >
                      {it.label}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>

            <View
              pointerEvents="none"
              style={[
                styles.timeWheelHighlight,
                !locationTouched && styles.timeWheelHighlightGhost,
                { top: wheelCenterTop, height: ITEM_H },
              ]}
            />
          </View>
        );
      };

      const renderFolderDropdown = () => {
        return (
          <View style={[styles.timeDropdown, { height: ITEM_H * FOLDER_ITEMS.length + 12 }]}>
            <View style={{ paddingVertical: 6 }}>
              {FOLDER_ITEMS.map((it, i) => {
                const on = it.value ? newFolder === it.value : false;
                const isDisabled = !!it.disabled || !it.value;
                return (
                  <Pressable
                    key={`folder-${it.value ?? "soon-" + i}`}
                    disabled={isDisabled}
                    onPress={() => {
                      if (!it.value) return;
                      setNewFolder(it.value);
                      setFolderPickerOpen(false);
                    }}
                    style={[styles.timeOpt, { height: ITEM_H }, isDisabled && { opacity: 0.45 }]}
                  >
                    <Text style={[styles.timeOptText, on && styles.timeOptTextOn, isDisabled && { fontStyle: "italic" }]}>
                      {it.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        );
      };

      const onPickHour = (h: number) => {
        setNewHour(pad2(h));
        setTimeTouched(true);
      };

      const onPickMinute = (m: number) => {
        setNewMinute(pad2(m));
        setTimeTouched(true);
      };

      const onPickEndHour = (h: number) => {
        setNewEndHour(pad2(h));
        setEndTimeTouched(true);
      };

      const onPickEndMinute = (m: number) => {
        setNewEndMinute(pad2(m));
        setEndTimeTouched(true);
      };

      const toggleTimePickers = () => {
        const open = !(hourPickerOpen || minutePickerOpen);
        setHourPickerOpen(open);
        setMinutePickerOpen(open);
        if (open) {
          setLocationPickerOpen(false);
          setFolderPickerOpen(false);
        }
      };

      const toggleEndTimePickers = () => {
        const open = !(endHourPickerOpen || endMinutePickerOpen);
        setEndHourPickerOpen(open);
        setEndMinutePickerOpen(open);
        if (open) {
          setHourPickerOpen(false);
          setMinutePickerOpen(false);
          setLocationPickerOpen(false);
          setFolderPickerOpen(false);
        }
      };

      const toggleLocationPicker = () => {
        const open = !locationPickerOpen;
        setLocationPickerOpen(open);
        if (open) {
          setHourPickerOpen(false);
          setMinutePickerOpen(false);
          setFolderPickerOpen(false);
        }
      };

      const toggleFolderPicker = () => {
        if (!canPickFolder) return;
        const open = !folderPickerOpen;
        setFolderPickerOpen(open);
        if (open) {
          setHourPickerOpen(false);
          setMinutePickerOpen(false);
          setLocationPickerOpen(false);
        }
      };

      const locationLabel = !locationTouched ? "Select location" : newLocation ? newLocation : "No location";
      const folderLabel = isDefaultEdit ? "Default Events" : "Custom Events";

      const nameOk = !!newName.trim();
      const timeOk = timeTouched;
      const locationOk = allowBlankLocation ? locationTouched : locationTouched && !!newLocation.trim();

      return (
        <>
          <TouchableOpacity
            onPress={() => {
              if (isOpen) resetForm();
              else openAddMarker();
            }}
            activeOpacity={0.8}
            style={[styles.addMarkerBtn, isOpen && styles.addMarkerBtnOn]}
          >
            <Text style={[styles.addMarkerBtnText, isOpen && styles.addMarkerBtnTextOn]}>
              {isOpen ? "Hide Add Event" : "Add Event"}
            </Text>

            <View style={{ position: "absolute", right: 14, top: 0, bottom: 0, justifyContent: "center" }}>
              <Ionicons name={isOpen ? "chevron-up" : "chevron-down"} size={18} color={isOpen ? ACCENT : SOFT_WHITE} />
            </View>
          </TouchableOpacity>

          {isOpen ? (
            <View style={styles.addDropdown}>
              {/* Folder (NEW) */}
              <Text style={styles.fieldLabel}>Folder</Text>
              <Pressable
                onPress={toggleFolderPicker}
                style={[
                  styles.locationBox,
                  folderPickerOpen && styles.locationBoxOn,
                  (!canPickFolder || isDefaultEdit) && { opacity: 0.70 },
                ]}
                android_ripple={{ color: "rgba(255,255,255,0.06)" }}
              >
                <Text style={styles.timeBoxLabel}>Folder</Text>
                <Text style={styles.locationSelectText}>{folderLabel}</Text>
              </Pressable>

              {folderPickerOpen ? <View style={{ marginTop: 8 }}>{renderFolderDropdown()}</View> : null}

              <Text style={[styles.fieldLabel, { marginTop: 10 }]}>Event Name</Text>
              <TextInput
                value={newName}
                onChangeText={setNewName}
                placeholder="e.g. Flow Tree Grove"
                placeholderTextColor="rgba(252,248,240,0.45)"
                style={styles.input}
              />

              <Text style={[styles.fieldLabel, { marginTop: 10 }]}>Event Location</Text>

              <Pressable
                onPress={toggleLocationPicker}
                style={[styles.locationBox, locationPickerOpen && styles.locationBoxOn]}
                android_ripple={{ color: "rgba(255,255,255,0.06)" }}
              >
                <Text style={styles.timeBoxLabel}>Location</Text>
                <Text style={[styles.locationSelectText, !locationTouched && { color: "rgba(252,248,240,0.45)" }]}>
                  {locationLabel}
                </Text>
              </Pressable>

              {locationPickerOpen ? <View style={{ marginTop: 8 }}>{renderLocationWheel()}</View> : null}

              <Text style={[styles.fieldLabel, { marginTop: 10 }]}>Event Time</Text>

              <Pressable
                onPress={toggleTimePickers}
                style={[styles.timeBox, (hourPickerOpen || minutePickerOpen) && styles.timeBoxOn]}
                android_ripple={{ color: "rgba(255,255,255,0.06)" }}
              >
                <Text style={styles.timeBoxLabel}>Time</Text>

                {/* FIX: center the hour/minute display inside the field */}
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10 }}>
                  <Text style={[styles.timeBoxValue, !timeTouched && { color: "rgba(252,248,240,0.45)" }]}>
                    {timeTouched ? newHour : "Hour"}
                  </Text>

                  <Text style={styles.timeColon}>:</Text>

                  <Text style={[styles.timeBoxValue, !timeTouched && { color: "rgba(252,248,240,0.45)" }]}>
                    {timeTouched ? newMinute : "Minute"}
                  </Text>
                </View>
              </Pressable>

              {hourPickerOpen || minutePickerOpen ? (
                <View style={styles.timePickersWrap}>
                  {renderWheel("hour", HOURS, parseInt(newHour, 10), onPickHour, !timeTouched, hourWheelRef)}
                  {renderWheel("minute", MINUTES, parseInt(newMinute, 10), onPickMinute, !timeTouched, minuteWheelRef)}
                </View>
              ) : null}
              <Text style={[styles.fieldLabel, { marginTop: 10 }]}>Duration</Text>

              <View style={styles.durationChipsRow}>
                <Pressable
                  onPress={() => {
                    setNewHasRange(false);
                    setEndHourPickerOpen(false);
                    setEndMinutePickerOpen(false);
                    setEndTimeTouched(false);
                  }}
                  style={[
                    styles.durationChip,
                    !newHasRange && styles.durationChipOn,
                  ]}
                >
                  <Text style={[styles.durationChipText, !newHasRange && styles.durationChipTextOn]}>
                    One-time
                  </Text>
                </Pressable>

                <Pressable
                  onPress={() => {
                    // Turning on range should "just work" without a manual:
                    // if end time isn't set, default to +60 minutes from start.
                    if (!newHasRange) {
                      const { h, m } = clampTimeInputs(newHour, newMinute);
                      const start = h * 60 + m;
                      const end = (start + 60) % 1440;
                      const eh = Math.floor(end / 60);
                      const em = end % 60;
                      setNewEndHour(pad2(eh));
                      setNewEndMinute(pad2(em));
                      setEndTimeTouched(true);
                    }
                    setNewHasRange(true);
                  }}
                  style={[
                    styles.durationChip,
                    newHasRange && styles.durationChipOn,
                  ]}
                >
                  <Text style={[styles.durationChipText, newHasRange && styles.durationChipTextOn]}>
                    Timed
                  </Text>
                </Pressable>
              </View>

              {newHasRange ? (
                <>
                  <Text style={[styles.fieldLabel, { marginTop: 10 }]}>Ends At</Text>

                  <Pressable
                    onPress={toggleEndTimePickers}
                    style={[styles.timeBox, (endHourPickerOpen || endMinutePickerOpen) && styles.timeBoxOn]}
                    android_ripple={{ color: "rgba(255,255,255,0.06)" }}
                  >
                    <Text style={styles.timeBoxLabel}>End</Text>

                    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10 }}>
                      <Text style={[styles.timeBoxValue, !endTimeTouched && { color: "rgba(252,248,240,0.45)" }]}>
                        {endTimeTouched ? newEndHour : "Hour"}
                      </Text>

                      <Text style={styles.timeColon}>:</Text>

                      <Text style={[styles.timeBoxValue, !endTimeTouched && { color: "rgba(252,248,240,0.45)" }]}>
                        {endTimeTouched ? newEndMinute : "Minute"}
                      </Text>
                    </View>
                  </Pressable>

                  {endHourPickerOpen || endMinutePickerOpen ? (
                    <View style={styles.timePickersWrap}>
                      {renderWheel("endHour", HOURS, parseInt(newEndHour, 10), onPickEndHour, !endTimeTouched, endHourWheelRef)}
                      {renderWheel("endMinute", MINUTES, parseInt(newEndMinute, 10), onPickEndMinute, !endTimeTouched, endMinuteWheelRef)}
                    </View>
                  ) : null}
                </>

              

              ) : null}


              <Text style={[styles.fieldLabel, { marginTop: 10 }]}>Notes (optional)</Text>
              <TextInput
                value={newNotes}
                onChangeText={setNewNotes}
                placeholder="Add custom details, reminders, or anything you want to remember..."
                placeholderTextColor="rgba(252,248,240,0.45)"
                style={[styles.input, styles.notesInput]}
                multiline
                textAlignVertical="top"
              />

              <TouchableOpacity
                activeOpacity={0.85}
                onPress={() => {
                  if (!isDefaultEdit && !newLocation.trim()) return;
                  if (!timeTouched) return;
                  if (newHasRange && !endTimeTouched) return;

                  addOrSave();
                }}
                style={[styles.saveMarkerBtn, (!nameOk || !timeOk || !locationOk || (newHasRange && !endTimeTouched)) && styles.saveMarkerBtnDisabled]}
              >
                <Text style={styles.saveMarkerBtnText}>{editingId ? "Save Changes" : "Save Event"}</Text>
              </TouchableOpacity>
            </View>
          ) : null}
        </>
      );
    })()}
  </View>
) : null}

{/* SECTION 19.7) Markers card  (Marker Setup screen) */}

{screen === "marker_setup" ? (
  <View style={styles.card}>
    <Text style={styles.cardTitle}>Event Folders</Text>

    {(() => {
      const editingIsDefault = Boolean(editingId && String(editingId).startsWith("default_"));
      const editingIsRepeatable = Boolean(editingId && String(editingId).startsWith("repeat_"));
      const editingIsFish = Boolean(editingId && String(editingId).startsWith("fish_"));
      const editingIsCustom = Boolean(editingId && !editingIsDefault && !editingIsRepeatable && !editingIsFish);

      const defOpen = defaultMarkersOpen || editingIsDefault;
      const cusOpen = customMarkersOpen || editingIsCustom;
      const fishOpen = fishMarkersOpen || editingIsFish;
      const repOpen = repeatableMarkersOpen || editingIsRepeatable;

      // Folder-wide states (used to decide labels)
      const defAllEnabled = defaultMarkers.length > 0 && defaultMarkers.every((m) => m.enabled);
      const defAllNotify = defaultMarkers.length > 0 && defaultMarkers.every((m) => m.notify);

      const cusAllEnabled = customMarkers.length > 0 && customMarkers.every((m) => m.enabled);
      const cusAllNotify = customMarkers.length > 0 && customMarkers.every((m) => m.notify);

      const fishAllEnabled = fishMarkers.length > 0 && fishMarkers.every((m) => m.enabled);
      const fishAllNotify = fishMarkers.length > 0 && fishMarkers.every((m) => m.notify);

      const repAllEnabled = repeatableMarkers.length > 0 && repeatableMarkers.every((m) => m.enabled);
      const repAllNotify = repeatableMarkers.length > 0 && repeatableMarkers.every((m) => m.notify);

      // Stored as "Event Name - Location" (location optional)
      // IMPORTANT: locations can contain " - " internally (e.g. "K - Kilima Village").
      // Split on the FIRST separator only, otherwise "K -" leaks into the event name.
      const splitNameLocation = (full: string) => {
        const sep = " - ";
        const s = full || "";
        const i = s.indexOf(sep);
        if (i === -1) return { eventName: s, location: "" };
        const eventName = s.slice(0, i).trim();
        const location = s.slice(i + sep.length).trim();
        return { eventName: eventName || s, location };
      };

      // Per-folder sorting (display-only)
      const sortByTime = (a: Marker, b: Marker) => {
        if (a.hour !== b.hour) return a.hour - b.hour;
        if (a.minute !== b.minute) return a.minute - b.minute;
        return String(a.id).localeCompare(String(b.id));
      };

      const sortByNext = (a: Marker, b: Marker) => {
        const ca = countdowns[a.id] ?? 9e15;
        const cb = countdowns[b.id] ?? 9e15;
        if (ca !== cb) return ca - cb;
        return sortByTime(a, b);
      };

      const defaultMarkersView = (() => {
        const arr = [...defaultMarkers];
        return (defaultMarkersSort === "time" ? arr.sort(sortByTime) : arr.sort(sortByNext));
      })();

      const customMarkersView = (() => {
        const arr = [...customMarkers];
        return (customMarkersSort === "time" ? arr.sort(sortByTime) : arr.sort(sortByNext));
      })();

      const repeatableMarkersView = (() => {
        const arr = [...repeatableMarkers];
        return (repeatableMarkersSort === "time" ? arr.sort(sortByTime) : arr.sort(sortByNext));
      })();

      const fishMarkersView = (() => {
        const arr = [...fishMarkers];
        return (fishMarkersSort === "time" ? arr.sort(sortByTime) : arr.sort(sortByNext));
      })();
      const renderRows = (rows: Marker[]) => {
              // Folder body renderer (height-capped). We intentionally avoid FlatList here because
              // the whole screen is already a ScrollView and nesting VirtualizedLists breaks
              // scrolling on native.
              const renderItem = ({ item: m }: { item: Marker }) => {
                const disabled = !m.enabled;
                const isProtected = isProtectedMarkerId(m.id);
                const notesOpen = expandedEventNotesId === m.id;

                // Guard: on web, presses can bubble from inner chips to the row.
                // Pressables in this project must use zero-arg callbacks, so we use a simple guard flag.
                let rowGuard = false;

                const toggleNotes = () => {
                  try {
                    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                  } catch {}
                  setExpandedEventNotesId((prev) => (prev === m.id ? null : m.id));
                };

                const { eventName, location } = splitNameLocation(m.name);
                const hasRange = !!m.hasRange && typeof m.endHour === "number" && typeof m.endMinute === "number";
                const timeLabel = hasRange
                  ? `${format12hTime(m.hour, m.minute)} - ${format12hTime(m.endHour as number, m.endMinute as number)}`
                  : format12hTime(m.hour, m.minute);

                return (
                  <View style={{ marginBottom: 12 }}>
                    <Pressable
                      onPress={() => {
                        if (rowGuard) {
                          rowGuard = false;
                          return;
                        }
                        toggleNotes();
                      }}
                      style={[
                        styles.markerRow,
                        { paddingVertical: densityVars.rowPadV },
                        disabled && styles.markerRowDisabled,
                      ]}
                    >
                      <Pressable
                        onPress={() => {
                          rowGuard = true;
                          toggleEnabled(m.id);
                        }}
                        style={[styles.checkBox, m.enabled && styles.checkBoxOn]}
                        hitSlop={8}
                      >
                        {m.enabled ? <Text style={styles.checkMark}>✓</Text> : null}
                      </Pressable>

                      <View style={styles.markerTextCol}>
                        <Text style={[styles.markerName, disabled && styles.dimText]} numberOfLines={1}>
                          {eventName}
                        </Text>

                        {location ? (
                          <Text style={[styles.markerLocation, disabled && styles.dimText]} numberOfLines={1}>
                            {location}
                          </Text>
                        ) : null}

                        <View style={styles.markerTimeRow}>
                          <Text style={[styles.markerTimeText, disabled && styles.dimText]}>{timeLabel}</Text>
                        </View>
                      </View>

                      <View style={styles.markerActionsRow}>
                        {!isProtected ? (
                          <ScalePressable
                            onPress={() => {
                              rowGuard = true;
                              startEdit(m);
                            }}
                            style={styles.actionIconChip}
                          >
                            <Ionicons name="pencil" size={16} color={SOFT_WHITE} />
                          </ScalePressable>
                        ) : null}

                        <ScalePressable
                          onPress={() => {
                            rowGuard = true;
                            toggleNotify(m.id);
                          }}
                          style={[styles.actionIconChip, !m.enabled && styles.actionChipDisabled]}
                          disabled={!m.enabled}
                        >
                          <Ionicons
                            name={m.notify ? "notifications-outline" : "notifications-off-outline"}
                            size={18}
                            color={!m.enabled ? SOFT_WHITE_DIM : m.notify ? ACCENT : SOFT_WHITE_DIM}
                          />
                        </ScalePressable>

                        {!isProtected ? (
                          <ScalePressable
                            onPress={() => {
                              rowGuard = true;
                              deleteMarker(m.id);
                            }}
                            style={styles.actionIconChip}
                          >
                            <Ionicons name="trash-outline" size={18} color={SOFT_WHITE_DIM} />
                          </ScalePressable>
                        ) : null}
                      </View>
                    </Pressable>

                    {notesOpen ? (
                      <View style={styles.eventNotesDrop}
                      >
                        <Text style={styles.eventNotesLabel}>Notes</Text>
                        <Text style={styles.eventNotesText}>
                          {String(m.notes ?? "").trim().length > 0
                            ? String(m.notes).trim()
                            : "No notes yet."}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                );
              };

              // IMPORTANT (native): don't nest a VirtualizedList (FlatList) inside the main
              // screen ScrollView. Android especially will complain and scrolling can break.
              // These folder bodies are height-capped anyway, so a plain ScrollView is fine.
              return (
                <ScrollView
                  style={{ maxHeight: FOLDER_BODY_MAX_H }}
                  contentContainerStyle={{ paddingBottom: 2 }}
                  showsVerticalScrollIndicator={false}
                  nestedScrollEnabled
                  keyboardShouldPersistTaps="handled"
                >
                  {rows.map((m, index) => (
                    <React.Fragment key={String(m.id)}>
                      {renderItem({ item: m, index } as any)}
                    </React.Fragment>
                  ))}
                </ScrollView>
              );
            };

      const emptyLine = (t: string) => (
        <Text style={[styles.nextEmpty, { marginTop: 10, opacity: 0.78 }]}>
          {" - "}
          {t}
        </Text>
      );

      const ActionChip = ({
        icon,
        label,
        onPress,
        disabled,
      }: {
        icon: any;
        label: string;
        onPress: () => void;
        disabled?: boolean;
      }) => (
        <ScalePressable
          onPress={onPress}
          disabled={disabled}
          style={[styles.actionChip, disabled && styles.actionChipDisabled]}
        >
          <Ionicons name={icon} size={14} color={disabled ? SOFT_WHITE_DIM : SOFT_WHITE} />
          <Text style={styles.actionChipText}>{label}</Text>
        </ScalePressable>
      );

      return (
        <ScrollView
          contentContainerStyle={{ paddingBottom: 6 }}
          keyboardShouldPersistTaps="handled"
          // Android: allow inner folder-body ScrollViews to scroll inside this ScrollView.
          nestedScrollEnabled
          stickyHeaderIndices={[0, 2, 4, 6]}
          showsVerticalScrollIndicator={false}
        >
          {/* Folder: Default Events (sticky header) */}
          <View style={[styles.folderHeaderSticky, { marginTop: 8 }]}>
            <ScalePressable
              onPress={() => {
                if (editingIsDefault) return;
                toggleDefaultFolder();
              }}
              disabled={editingIsDefault}
              style={[styles.folderRow, defOpen && styles.folderRowOn]}
            >
              <Text style={[styles.addMarkerBtnText, defOpen && styles.addMarkerBtnTextOn]}>
                Default Events • {defaultMarkers.length}
              </Text>

              <View style={{ position: "absolute", right: 14, top: 0, bottom: 0, justifyContent: "center" }}>
                <Ionicons name={defaultMarkersOpen ? "chevron-up" : "chevron-down"} size={18} color={SOFT_WHITE_DIM} />
              </View>
            </ScalePressable>
          </View>

          <Animated.View style={[{ marginTop: 10 }, folderBodyStyle(defaultFolderT)]} pointerEvents={defOpen ? "auto" : "none"}>
            {defaultMarkers.length ? (
              <>
                <View style={styles.folderBulkRow}>
  <View style={styles.folderBulkLeft}>
    <ActionChip
                    icon={defAllEnabled ? "close-circle-outline" : "checkmark-circle-outline"}
                    label={defAllEnabled ? "Disable" : "Enable"}
                    onPress={() => setEnabledForMany(defaultMarkers.map((m) => m.id), !defAllEnabled)}
                  />

    <ActionChip
                    icon={defAllNotify ? "notifications-off-outline" : "notifications-outline"}
                    label={defAllNotify ? "Mute" : "Unmute"}
                    onPress={() => setNotifyForMany(defaultMarkers.map((m) => m.id), !defAllNotify)}
                  />
  </View>
  <View style={styles.folderBulkRight}>
    <ActionChip
                    icon={defaultMarkersSort === "time" ? "time-outline" : "flash-outline"}
                    label={defaultMarkersSort === "time" ? "Sort: Time" : "Sort: Next"}
                    onPress={toggleDefaultSort}
                  />
  </View>
</View>

                {renderRows(defaultMarkersView)}
              </>
            ) : (
              emptyLine("No default events")
            )}
          </Animated.View>

          {/* Folder: Custom Events (sticky header) */}
          <View style={[styles.folderHeaderSticky, { marginTop: 8 }]}>
            <ScalePressable
              onPress={() => {
                if (editingIsCustom) return;
                toggleCustomFolder();
              }}
              disabled={editingIsCustom}
              style={[styles.addMarkerBtn, cusOpen && styles.addMarkerBtnOn]}
            >
              <Text style={[styles.addMarkerBtnText, cusOpen && styles.addMarkerBtnTextOn]}>
                Custom Events • {customMarkers.length}
              </Text>

              <View style={{ position: "absolute", right: 14, top: 0, bottom: 0, justifyContent: "center" }}>
                <Ionicons name={customMarkersOpen ? "chevron-up" : "chevron-down"} size={18} color={SOFT_WHITE_DIM} />
              </View>
            </ScalePressable>
          </View>

          <Animated.View style={[{ marginTop: 10 }, folderBodyStyle(customFolderT)]} pointerEvents={cusOpen ? "auto" : "none"}>
            {customMarkers.length ? (
              <>
                <View style={styles.folderBulkRow}>
  <View style={styles.folderBulkLeft}>
    <ActionChip
                    icon={cusAllEnabled ? "close-circle-outline" : "checkmark-circle-outline"}
                    label={cusAllEnabled ? "Disable" : "Enable"}
                    onPress={() => setEnabledForMany(customMarkers.map((m) => m.id), !cusAllEnabled)}
                  />

    <ActionChip
                    icon={cusAllNotify ? "notifications-off-outline" : "notifications-outline"}
                    label={cusAllNotify ? "Mute" : "Unmute"}
                    onPress={() => setNotifyForMany(customMarkers.map((m) => m.id), !cusAllNotify)}
                  />
  </View>
  <View style={styles.folderBulkRight}>
    <ActionChip
                    icon={customMarkersSort === "time" ? "time-outline" : "flash-outline"}
                    label={customMarkersSort === "time" ? "Sort: Time" : "Sort: Next"}
                    onPress={toggleCustomSort}
                  />
  </View>
</View>

                {renderRows(customMarkersView)}
              </>
            ) : (
              emptyLine("No custom events yet. Add one above.")
            )}
          </Animated.View>

                    {/* Folder: Fish Events (sticky header) */}
          <View style={[styles.folderHeaderSticky, { marginTop: 8 }]}>
            <ScalePressable
              onPress={() => {
                // Fish events aren't editable in-app, so no "editing lock" needed here.
                toggleFishFolder();
              }}
              style={[styles.addMarkerBtn, fishOpen && styles.addMarkerBtnOn]}
            >
              <Text style={[styles.addMarkerBtnText, fishOpen && styles.addMarkerBtnTextOn]}>
                Fish • {fishMarkers.length}
              </Text>

              <View style={{ position: "absolute", right: 14, top: 0, bottom: 0, justifyContent: "center" }}>
                <Ionicons name={fishOpen ? "chevron-up" : "chevron-down"} size={18} color={SOFT_WHITE_DIM} />
              </View>
            </ScalePressable>
          </View>

          <Animated.View style={[{ marginTop: 10 }, folderBodyStyle(fishFolderT)]} pointerEvents={fishOpen ? "auto" : "none"}>
            {fishMarkers.length ? (
              <>
                <View style={styles.folderBulkRow}>
                  <View style={styles.folderBulkLeft}>
                    <ActionChip
                      icon={fishAllEnabled ? "close-circle-outline" : "checkmark-circle-outline"}
                      label={fishAllEnabled ? "Disable" : "Enable"}
                      onPress={() => setEnabledForMany(fishMarkers.map((m) => m.id), !fishAllEnabled)}
                    />

                    <ActionChip
                      icon={fishAllNotify ? "notifications-off-outline" : "notifications-outline"}
                      label={fishAllNotify ? "Mute" : "Unmute"}
                      onPress={() => setNotifyForMany(fishMarkers.map((m) => m.id), !fishAllNotify)}
                    />
                  </View>

                  <View style={styles.folderBulkRight}>
                    <ActionChip
                      icon={fishMarkersSort === "time" ? "time-outline" : "flash-outline"}
                      label={fishMarkersSort === "time" ? "Sort: Time" : "Sort: Next"}
                      onPress={toggleFishSort}
                    />
                  </View>
                </View>

                {fishOpen ? renderRows(fishMarkersView) : null}
              </>
            ) : (
              emptyLine(
                remoteFishStatus === "loading"
                  ? "Fetching fish list..."
                  : remoteFishStatus === "error"
                  ? "Fish list failed to load. (Native: ensure the hosted fish.json URL is live.)"
                  : "Fish list is empty (0 items). Check fish.json format."
              )
            )}
          </Animated.View>

          {/*Folder: Repeatable Events (sticky header) */}
          <View style={[styles.folderHeaderSticky, { marginTop: 8 }]}>
            <ScalePressable
              onPress={() => {
                if (editingIsRepeatable) return;
                toggleRepeatableFolder();
              }}
              disabled={editingIsRepeatable}
              style={[styles.folderRow, repOpen && styles.folderRowOn]}
            >
              <Text style={[styles.addMarkerBtnText, repOpen && styles.addMarkerBtnTextOn]}>
                Repeatable Events • {repeatableMarkers.length}
              </Text>

              <View style={{ position: "absolute", right: 14, top: 0, bottom: 0, justifyContent: "center" }}>
                <Ionicons name={repeatableMarkersOpen ? "chevron-up" : "chevron-down"} size={18} color={SOFT_WHITE_DIM} />
              </View>
            </ScalePressable>
          </View>

          <Animated.View style={[{ marginTop: 10 }, folderBodyStyle(repeatableFolderT)]} pointerEvents={repOpen ? "auto" : "none"}>
            {repeatableMarkers.length ? (
              <>
                <View style={styles.folderBulkRow}>
  <View style={styles.folderBulkLeft}>
    <ActionChip
                    icon={repAllEnabled ? "close-circle-outline" : "checkmark-circle-outline"}
                    label={repAllEnabled ? "Disable" : "Enable"}
                    onPress={() => setEnabledForMany(repeatableMarkers.map((m) => m.id), !repAllEnabled)}
                  />

    <ActionChip
                    icon={repAllNotify ? "notifications-off-outline" : "notifications-outline"}
                    label={repAllNotify ? "Mute" : "Unmute"}
                    onPress={() => setNotifyForMany(repeatableMarkers.map((m) => m.id), !repAllNotify)}
                  />
  </View>
  <View style={styles.folderBulkRight}>
    <ActionChip
                    icon={repeatableMarkersSort === "time" ? "time-outline" : "flash-outline"}
                    label={repeatableMarkersSort === "time" ? "Sort: Time" : "Sort: Next"}
                    onPress={toggleRepeatableSort}
                  />
  </View>
</View>

                {renderRows(repeatableMarkersView)}
              </>
            ) : (
              emptyLine("No repeatable events yet")
            )}
          </Animated.View>
        </ScrollView>
      );
})()}
  </View>
) : null}

{/* SECTION 19.8) Notifications card (removed) */}

{/* SECTION 19.8) Notifications card (removed) */}

        {/* Notifications are configured in the Settings modal now. */}

        <View style={{ height: 24 }} />
      </ScrollView>

{/* SECTION 19.9) Setup modal */}

      {/* Side menu drawer */}
      <Modal
        visible={menuVisible}
        transparent
        animationType="none"
        statusBarTranslucent
        onRequestClose={closeMenu}
      >
        <View style={styles.drawerRoot}>
          {/* Blurred + dimmed backdrop (web + native) */}
          <View pointerEvents="none" style={styles.drawerBackdrop}>
            {/* Keep blur visible: animate the dim layer, not the whole stack */}
            <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFillObject, { opacity: menuT }]}>
              <BlurView
                tint="dark"
                intensity={BACKDROP_BLUR_INTENSITY}
                experimentalBlurMethod={Platform.OS === "android" ? "dimezisBlurView" : "none"}
                style={StyleSheet.absoluteFillObject}
              />
            </Animated.View>

            <Animated.View pointerEvents="none" style={[styles.backdropDimHard, { opacity: drawerBackdropOp }]} />
          </View>

          <Pressable style={StyleSheet.absoluteFillObject} onPress={closeMenu} />

          <Animated.View
            style={[
              styles.drawerSheet,
              {
                width: DRAWER_W,
                // ✅ Physically lift the whole sheet off status + nav bars (no fake padding bars)
                top: Math.max(insets.top, 0) + 10,
                bottom: Math.max(insets.bottom, 0) + 10,
                transform: [{ translateX: drawerX }],
              },
            ]}
          >
            <View style={styles.drawerHeader}>
              <Text style={styles.drawerTitle}>Menu</Text>
              <Pressable onPress={closeMenu} style={styles.drawerClose} hitSlop={12}>
                <Ionicons name="close" size={22} color={SOFT_WHITE_DIM} />
              </Pressable>
            </View>

            <View style={styles.drawerBody}>
              <Pressable
                onPress={goToMarkerSetup}
                style={styles.drawerItem}
                android_ripple={{ color: "rgba(255,255,255,0.08)" }}
              >
                <Ionicons name="pin-outline" size={18} color={SOFT_WHITE} />
                <Text style={styles.drawerItemText}>Event Setup</Text>
              </Pressable>

            </View>

            <View style={styles.drawerFooter}>
              <Text style={styles.drawerFooterText}>More Coming Soon...</Text>

              <Pressable
                onPress={() => {
                  closeMenu();
                  setRoadmapOpen(true);
                }}
                style={[styles.drawerItem, { marginTop: 12 }]}
                android_ripple={{ color: "rgba(255,255,255,0.08)" }}
              >
                <Ionicons name="map-outline" size={18} color={SOFT_WHITE} />
                <Text style={styles.drawerItemText}>Roadmap</Text>
              </Pressable>
            </View>
          </Animated.View>
        </View>
      </Modal>

{/* Settings modal */}
      <Modal
        visible={setupOpen}
        transparent
        animationType="slide"
        statusBarTranslucent
        onRequestClose={() => setSetupOpen(false)}
      >
        <View style={styles.modalBackdrop}>
          {/* Blurred background behind the sheet */}
          <BlurView
            tint="dark"
            intensity={BACKDROP_BLUR_INTENSITY}
            experimentalBlurMethod={Platform.OS === "android" ? "dimezisBlurView" : "none"}
            style={StyleSheet.absoluteFillObject}
          />
          {/* Soft dim over blur */}
          <View pointerEvents="none" style={styles.backdropDimSoft} />

          <Pressable style={styles.modalBackdropPress} onPress={() => setSetupOpen(false)} />

          <View style={[styles.modalSheet, { height: Math.min(820, SCREEN_H * 0.875) }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Settings</Text>

              <View style={styles.modalHeaderRight}>

                <Pressable onPress={() => setSetupOpen(false)} style={styles.modalClose} hitSlop={12}>
                  <Ionicons name="close" size={22} color={SOFT_WHITE_DIM} />
                </Pressable>
              </View>
            </View>

            <ScrollView contentContainerStyle={styles.modalContent} keyboardShouldPersistTaps="handled">
              {/* TEXT SIZE */}
              <View style={styles.modalSection}>
                <View style={styles.modalSectionTitleRow}>
                  <View style={styles.modalSectionTitleIconWrap}>
                    <Ionicons name="text-outline" size={18} color={ACCENT} />
                  </View>
                  <Text style={styles.modalSectionTitle}>Text Size</Text>
                </View>

                <View style={styles.clockSettingsCard}>
                  <Text style={styles.settingsCardTitle}>Visibility</Text>

                  <View style={[styles.textSizeHeaderPills, { marginTop: 10 }]}>
                    {([
                      { key: "small", label: "Small" },
                      { key: "medium", label: "Medium" },
                      { key: "large", label: "Large" },
                    ] as { key: TextSizeMode; label: string }[]).map((opt) => {
                      const on = textSizeMode === opt.key;
                      return (
                        <Pressable
                          key={opt.key}
                          onPress={() => setTextSizeModePersist(opt.key)}
                          style={[styles.textSizePill, on && styles.textSizePillOn]}
                        >
                          <Text style={[styles.textSizePillText, on && styles.textSizePillTextOn]}>
                            {opt.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              </View>


              {/* CLOCK SETTINGS */}
              <View style={styles.modalSection}>
                <View style={styles.modalSectionTitleRow}>
                  <View style={styles.modalSectionTitleIconWrap}>
                    <Ionicons name="time-outline" size={18} color={ACCENT} />
                  </View>
                  <Text style={styles.modalSectionTitle}>Clock Settings</Text>
                </View>

                <View style={styles.clockSettingsCard}>
                  <Text style={styles.settingsCardTitle}>Display</Text>

<Pressable
                  onPress={() => setRotateClock((v) => !v)}
                  style={[styles.modalRow, rotateClock && styles.modalRowOnAccent]}
                >
                  <Text style={styles.modalRowLabel}>Rotate clock around timeline</Text>
                  <View style={[styles.modalPill, rotateClock && styles.modalPillOnAccent]}>
                    <Text style={[styles.modalPillText, rotateClock && styles.modalPillTextOnAccent]}>
                      {rotateClock ? "On" : "Off"}
                    </Text>
                  </View>
                </Pressable>

                </View>

                <View style={[styles.clockSettingsCard, { marginTop: 12 }]}>

<Text style={styles.settingsCardTitle}>Notifications</Text>

                {(() => {
                  const isWeb = Platform.OS === "web";

                  // Web support: Browser Notification API (HTTPS/localhost only).
                  const webHasApi = (() => {
                    if (!isWeb) return false;
                    const anyWin = globalThis as any;
                    return typeof anyWin?.Notification !== "undefined";
                  })();

                  const webSecure = (() => {
                    if (!isWeb) return false;
                    try {
                      const anyWin = globalThis as any;
                      const host = String(anyWin?.location?.hostname ?? "");
                      const proto = String(anyWin?.location?.protocol ?? "");
                      const secureContext = Boolean(anyWin?.isSecureContext);
                      return secureContext || proto === "https:" || host === "localhost" || host === "127.0.0.1";
                    } catch {
                      return false;
                    }
                  })();

                  // Web support requires the Notification API AND a secure context (https or localhost)
                  const webSupported = isWeb && webHasApi && webSecure;

                  const webPermission = (() => {
                    if (!isWeb || !webSupported) return "unsupported" as const;
                    try {
                      const anyWin = globalThis as any;
                      return (anyWin.Notification.permission ?? "default") as "granted" | "denied" | "default";
                    } catch {
                      return "default" as const;
                    }
                  })();

                  const canUseNotifs = !isWeb || webSupported;
                  const rowOn = canUseNotifs && notifEnabled;

                  const pillText = (() => {
                    if (!canUseNotifs) {
                      // Web: distinguish "no API" vs "needs https/localhost"
                      if (isWeb) {
                        if (typeof webHasApi !== "undefined" && webHasApi && typeof webSecure !== "undefined" && !webSecure) {
                          return "HTTPS";
                        }
                      }
                      return "N/A";
                    }
                    if (!isWeb) return notifEnabled ? "On" : "Off";
                    if (webPermission === "denied") return "Blocked";
                    return notifEnabled ? "On" : "Off";
                  })();

                  const reminderDisabled = !canUseNotifs || !notifEnabled;

                  return (
                    <>
                      <Pressable
                        onPress={canUseNotifs ? toggleNotifications : undefined}
                        style={[styles.modalRow, rowOn && styles.modalRowOnAccent]}
                        disabled={!canUseNotifs}
                      >
                        <Text style={styles.modalRowLabel}>Status</Text>

                        <View style={[styles.modalPill, rowOn && styles.modalPillOnAccent]}>
                          <Text style={[styles.modalPillText, rowOn && styles.modalPillTextOnAccent]}>
                            {pillText}
                          </Text>
                        </View>
                      </Pressable>

                      {Platform.OS === "web" ? (
                        !canUseNotifs ? (
                          <View style={styles.notifHintWrap}>
                            <Text style={styles.notifHintText}>
                              Desktop notifications need HTTPS (or localhost) and browser permission.
                            </Text>
                          </View>
                        ) : webPermission === "denied" ? (
                          <View style={styles.notifHintWrap}>
                            <Text style={styles.notifHintText}>
                              Notifications are blocked for this site. Allow them in your browser’s site settings, then toggle this on again.
                            </Text>
                          </View>
                        ) : webPermission !== "granted" ? (
                          <View style={styles.notifHintWrap}>
                            <Text style={styles.notifHintText}>
                              Enabling will prompt your browser to allow desktop notifications (works while this tab is open).
                            </Text>
                          </View>
                        ) : null
                      ) : null}


                      {Platform.OS === "android" && Number(Platform.Version) >= 31 ? (
                        <View style={styles.notifHintWrap}>
                          <Text style={styles.notifHintText}>
                            If alerts are late on Android, enable “Alarms and reminders” and disable battery optimizations for this app.
                          </Text>
                          <Pressable onPress={() => Linking.openSettings()} style={styles.notifHintBtn}>
                            <Text style={styles.notifHintBtnText}>Open Settings</Text>
                          </Pressable>
                        </View>
                      ) : null}


                      <View style={{ marginTop: 12 }}>
                        <Text style={styles.modalHint}>Reminder (real time)</Text>
                        <View style={styles.reminderPills}>
                          {REMINDER_OPTIONS.map((sec) => {
                            const on = reminderLeadSeconds === sec;
                            const disabled = reminderDisabled;

                            return (
                              <TouchableOpacity
                                key={`rem-${sec}`}
                                onPress={() => setReminderLeadSeconds(sec)}
                                activeOpacity={0.85}
                                disabled={disabled}
                                style={[
                                  styles.reminderPill,
                                  on && styles.reminderPillOn,
                                  disabled && styles.reminderPillDisabled,
                                ]}
                              >
                                <Text
                                  style={[
                                    styles.reminderPillText,
                                    on && styles.reminderPillTextOn,
                                    disabled && styles.reminderPillTextDisabled,
                                  ]}
                                >
                                  {formatReminderChip(sec)}
                                </Text>
                              </TouchableOpacity>
                            );
                          })}
                        </View>
                      </View>
                    </>
                  );
                })()}

                </View>
              </View>

{/* WANT TO HELP? (closed testing) */}
              <View style={styles.modalSection}>
                <View style={styles.modalSectionTitleRow}>
                  <View style={styles.modalSectionTitleIconWrap}>
                    <Ionicons name="chatbubble-ellipses-outline" size={18} color={ACCENT} />
                  </View>
                  <Text style={styles.modalSectionTitle}>Want to help?</Text>
                </View>
                <Text style={[styles.notifHintText, { marginBottom: 10 }]}>
                  Send feedback, report a bug, or request a feature. Optional diagnostics can be included to help troubleshoot issues.
                </Text>

                <Pressable onPress={() => sendHelpEmail("feedback")} style={styles.helpActionBtn}>
                  <Ionicons name="chatbubble-ellipses-outline" size={18} color={ACCENT} />
                  <Text style={styles.helpActionText}>Send feedback</Text>
                </Pressable>

                <Pressable onPress={() => sendHelpEmail("bug")} style={styles.helpActionBtn}>
                  <Ionicons name="bug-outline" size={18} color={ACCENT} />
                  <Text style={styles.helpActionText}>Report a bug</Text>
                </Pressable>

                <Pressable onPress={() => sendHelpEmail("feature")} style={styles.helpActionBtn}>
                  <Ionicons name="sparkles-outline" size={18} color={ACCENT} />
                  <Text style={styles.helpActionText}>Request a feature</Text>
                </Pressable>

                <View style={{ height: 10 }} />

                <Pressable
                  onPress={() => setHelpIncludeDiagnostics((v) => !v)}
                  style={[styles.modalRow, helpIncludeDiagnostics && styles.modalRowOnAccent]}
                >
                  <Text style={styles.modalRowLabel}>Include diagnostics in emails</Text>
                  <View style={[styles.modalPill, helpIncludeDiagnostics && styles.modalPillOnAccent]}>
                    <Text style={[styles.modalPillText, helpIncludeDiagnostics && styles.modalPillTextOnAccent]}>
                      {helpIncludeDiagnostics ? "On" : "Off"}
                    </Text>
                  </View>
                </Pressable>

                <View style={styles.helpButtonRow}>
                  <Pressable onPress={shareDiagnostics} style={[styles.notifHintBtn, styles.helpHalfBtn]}>
                    <Text style={styles.notifHintBtnText}>Copy diagnostics</Text>
                  </Pressable>

                  <Pressable onPress={resetAppData} style={[styles.notifHintBtn, styles.helpHalfBtn]}>
                    <Text style={styles.notifHintBtnText}>Reset data</Text>
                  </Pressable>
                </View>

<View style={{ height: 12 }} />

<Text style={styles.modalHint}>Known issues</Text>
<Text style={[styles.notifHintText, { marginBottom: 10 }]}>
  {CLOSED_TEST_KNOWN_ISSUES.map((t) => `• ${t}`).join("\n")}
</Text>

<Text style={styles.modalHint}>What to test</Text>
<Text style={[styles.notifHintText, { marginBottom: 0 }]}>
  {CLOSED_TEST_WHAT_TO_TEST.map((t) => `• ${t}`).join("\n")}
</Text>

              </View>

              {/* CHANGELOG */}
              <View style={styles.modalSection}>
                <View style={styles.modalSectionTitleRow}>
                  <View style={styles.modalSectionTitleIconWrap}>
                    <Ionicons name="document-text-outline" size={18} color={ACCENT} />
                  </View>
                  <Text style={styles.modalSectionTitle}>Changelog</Text>
                </View>
                <Text style={[styles.notifHintText, { marginBottom: 10 }]}>
                  See what’s changed recently.
                </Text>

                <Pressable onPress={() => setChangelogOpen(true)} style={styles.notifHintBtn}>
                  <Text style={styles.notifHintBtnText}>Open changelog</Text>


                </Pressable>

      


              </View>

              <View style={{ height: 18 }} />
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Event details modal */}
      <Modal
        visible={eventDetailsOpen}
        transparent
        animationType="slide"
        statusBarTranslucent
        onRequestClose={() => setEventDetailsOpen(false)}
      >
        <View style={styles.modalBackdrop}>
          {/* Blurred background behind the sheet */}
          <BlurView
            tint="dark"
            intensity={BACKDROP_BLUR_INTENSITY}
            experimentalBlurMethod={Platform.OS === "android" ? "dimezisBlurView" : "none"}
            style={StyleSheet.absoluteFillObject}
          />
          {/* Soft dim over blur */}
          <View pointerEvents="none" style={styles.backdropDimSoft} />

          <Pressable
            style={styles.modalBackdropPress}
            onPress={() => {
              setEventDetailsOpen(false);
              setEventDetailsId(null);
            }}
          />

          <View style={[styles.modalSheet, { height: Math.min(520, SCREEN_H * 0.68) }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>📌 Event Details</Text>
              <Pressable
                onPress={() => {
                  setEventDetailsOpen(false);
                  setEventDetailsId(null);
                }}
                style={styles.modalClose}
                hitSlop={12}
              >
                <Ionicons name="close" size={22} color={SOFT_WHITE_DIM} />
              </Pressable>
            </View>

            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={[styles.modalContent, { paddingBottom: 16 }]}
              showsVerticalScrollIndicator={false}
            >
              {eventDetailsMarker ? (
                (() => {
                  const { eventName, location } = splitNameLocation(eventDetailsMarker.name);
                  const hasRange =
                    !!eventDetailsMarker.hasRange &&
                    typeof eventDetailsMarker.endHour === "number" &&
                    typeof eventDetailsMarker.endMinute === "number";

                  const timeText = hasRange
                    ? `${format12hTime(eventDetailsMarker.hour, eventDetailsMarker.minute)} - ${format12hTime(
                        eventDetailsMarker.endHour as number,
                        eventDetailsMarker.endMinute as number
                      )}`
                    : format12hTime(eventDetailsMarker.hour, eventDetailsMarker.minute);

                  return (
                    <>
                      <View style={styles.modalSection}>
                        <Text style={styles.modalSectionTitle}>{eventName}</Text>

                        {location ? (
                          <Text style={[styles.notifHintText, { marginTop: 2 }]}>
                            Location: <Text style={styles.eventDetailsValue}>{location}</Text>
                          </Text>
                        ) : null}

                        <Text style={[styles.notifHintText, { marginTop: 6 }]}>
                          Time: <Text style={styles.eventDetailsValue}>{timeText}</Text>
                        </Text>

                        <Text style={[styles.notifHintText, { marginTop: 6 }]}>
                          Enabled:{" "}
                          <Text style={styles.eventDetailsValue}>{eventDetailsMarker.enabled ? "Yes" : "No"}</Text>
                        </Text>

                        <Text style={[styles.notifHintText, { marginTop: 6 }]}>
                          Notifications:{" "}
                          <Text style={styles.eventDetailsValue}>{eventDetailsMarker.notify ? "On" : "Off"}</Text>
                        </Text>
                      </View>

                      <View style={styles.modalSection}>
                        <Text style={styles.modalSectionTitle}>Notes</Text>
                        <Text style={[styles.notifHintText, { marginBottom: 0 }]}>
                          {eventDetailsMarker.notes?.trim() ? eventDetailsMarker.notes : "No notes yet."}
                        </Text>
                      </View>
                    </>
                  );
                })()
              ) : (
                <View style={styles.modalSection}>
                  <Text style={styles.modalSectionTitle}>No event selected</Text>
                  <Text style={[styles.notifHintText, { marginBottom: 0 }]}>
                    Tap an event in the list to view its details.
                  </Text>
                </View>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>




      {/* Roadmap modal */}
      <Modal
        visible={roadmapOpen}
        transparent
        animationType="slide"
        statusBarTranslucent
        onRequestClose={() => setRoadmapOpen(false)}
      >
        <View style={styles.modalBackdrop}>
          {/* Blurred background behind the sheet */}
          <BlurView
            tint="dark"
            intensity={BACKDROP_BLUR_INTENSITY}
            experimentalBlurMethod={Platform.OS === "android" ? "dimezisBlurView" : "none"}
            style={StyleSheet.absoluteFillObject}
          />
          {/* Soft dim over blur */}
          <View pointerEvents="none" style={styles.backdropDimSoft} />

          <Pressable style={styles.modalBackdropPress} onPress={() => setRoadmapOpen(false)} />

          <View style={[styles.modalSheet, { height: Math.min(820, SCREEN_H * 0.875) }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>🌱 Roadmap</Text>
              <Pressable onPress={() => setRoadmapOpen(false)} style={styles.modalClose} hitSlop={12}>
                <Ionicons name="close" size={22} color={SOFT_WHITE_DIM} />
              </Pressable>
            </View>

	            <ScrollView
	              style={{ flex: 1 }}
	              contentContainerStyle={[styles.modalContent, { paddingBottom: 12 }]}
	              showsVerticalScrollIndicator={false}
	            >
              <View style={styles.modalSection}>
                <Text style={styles.modalSectionTitle}>Growing with Palia</Text>
                <Text style={[styles.notifHintText, { marginBottom: 0 }]}>
                  This app grows alongside Palia. Features roll out gradually, shaped by game updates and how players actually play.
                </Text>
              </View>

              <View style={styles.modalSection}>
                <Text style={styles.modalSectionTitle}>🌤️ Now</Text>
                <Text style={[styles.notifHintText, { marginBottom: 0 }]}>
                  • In-game time & event tracking{"\n"}• Notifications you control{"\n"}• Clean, cozy display options{"\n"}• Designed for calm, low-attention use
                </Text>
              </View>

              <View style={styles.modalSection}>
                <Text style={styles.modalSectionTitle}>🎨 Themes & Personalisation</Text>
                <Text style={[styles.notifHintText, { marginBottom: 0 }]}>
                  Multiple visual themes inspired by Palia{"\n"}Light, dark, and cozy mood presets{"\n"}Subtle accent colour choices{"\n\n"}Personalisation without clutter or noise{"\n"}Your app should feel like your plot.
                </Text>
              </View>

              <View style={styles.modalSection}>
                <Text style={styles.modalSectionTitle}>❄️ Seasonal Updates</Text>
                <Text style={[styles.notifHintText, { marginBottom: 0 }]}>
                  Limited-time events (Winterlights, seasonal festivals){"\n"}Event-aware reminders{"\n"}Optional seasonal visual touches
                </Text>
              </View>

              <View style={styles.modalSection}>
                <Text style={styles.modalSectionTitle}>🌙 Progression & Paths</Text>
                <Text style={[styles.notifHintText, { marginBottom: 0 }]}>
                  Lunar Path tracking{"\n"}Reward reminders{"\n"}Support for future paths
                </Text>
              </View>

              <View style={styles.modalSection}>
                <Text style={styles.modalSectionTitle}>🏡 Housing & Planning</Text>
                <Text style={[styles.notifHintText, { marginBottom: 0 }]}>
                  Decor & crafting planning tools{"\n"}Furniture sets & tint references{"\n"}Home project checklists
                </Text>
              </View>

              <View style={styles.modalSection}>
                <Text style={styles.modalSectionTitle}>🤝 Social & Story</Text>
                <Text style={[styles.notifHintText, { marginBottom: 0 }]}>
                  NPC relationship tracking{"\n"}Friendship & story reminders{"\n"}Light group planning tools
                </Text>
              </View>

              <View style={styles.modalSection}>
                <Text style={styles.modalSectionTitle}>🗺️ Exploration</Text>
                <Text style={[styles.notifHintText, { marginBottom: 0 }]}>
                  Zone-based events & activities{"\n"}Exploration checklists{"\n"}Time-sensitive highlights
                </Text>
              </View>

              <View style={styles.modalSection}>
                <Text style={styles.modalSectionTitle}>🧘 Comfort & Accessibility</Text>
                <Text style={[styles.notifHintText, { marginBottom: 0 }]}>
                  Adjustable text & motion{"\n"}Calm notification controls{"\n"}Designed for long, relaxed sessions
                </Text>
              </View>

              <View style={styles.modalSection}>
                <Text style={styles.modalSectionTitle}>💾 Your Data, Your Control</Text>
                <Text style={[styles.notifHintText, { marginBottom: 0 }]}>
                  Backup & restore options{"\n"}Multi-device safety{"\n"}Long-term reliability
                </Text>
              </View>

	              <View style={styles.modalSection}>
	                <Text style={styles.modalSectionTitle}>💬 Player Feedback</Text>
	                <Text style={[styles.notifHintText, { marginBottom: 0 }]}>
	                  Simple ways to share ideas{"\n"}Feedback helps shape future updates
	                </Text>
	              </View>
            </ScrollView>

	            {/* Outside-the-card footer line */}
	            <View style={[styles.roadmapFooterWrap, { paddingBottom: insets.bottom + 18 }]}>
	              <Text style={styles.roadmapFooterText}>
	                ✨ Features arrive gradually. Nothing here is required. Everything is optional.
	              </Text>
	            </View>
          </View>
        </View>
      </Modal>


      {/* Changelog modal */}
      <Modal
        visible={changelogOpen}
        transparent
        animationType="slide"
        statusBarTranslucent
        onRequestClose={() => setChangelogOpen(false)}
      >
        <View style={styles.modalBackdrop}>
          {/* Blurred background behind the sheet */}
          <BlurView
            tint="dark"
            intensity={BACKDROP_BLUR_INTENSITY}
            experimentalBlurMethod={Platform.OS === "android" ? "dimezisBlurView" : "none"}
            style={StyleSheet.absoluteFillObject}
          />
          {/* Soft dim over blur */}
          <View pointerEvents="none" style={styles.backdropDimSoft} />

          <Pressable style={styles.modalBackdropPress} onPress={() => setChangelogOpen(false)} />

          <View style={[styles.modalSheet, { height: Math.min(820, SCREEN_H * 0.875) }]}>
            <View style={styles.modalHeader}>
              <View style={styles.modalTitleRow}>
                <View style={styles.modalTitleIconWrap}>
                  <Ionicons name="document-text-outline" size={18} color={ACCENT} />
                </View>
                <Text style={styles.modalTitle}>Changelog</Text>
              </View>
              <Pressable onPress={() => setChangelogOpen(false)} style={styles.modalClose} hitSlop={12}>
                <Ionicons name="close" size={22} color={SOFT_WHITE_DIM} />
              </Pressable>
            </View>

            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={[styles.modalContent, { paddingBottom: 12 }]}
              showsVerticalScrollIndicator={false}
            >
              <View style={styles.modalSection}>
                <Text style={styles.modalSectionTitle}>January 2026 – Quality of Life Update</Text>
                <Text style={[styles.notifHintText, { marginBottom: 10 }]}>
                  A calmer, clearer update focused on guidance and polish.
                </Text>

                <Text style={styles.modalHint}>What’s new</Text>
                <View style={{ gap: 4, marginBottom: 10 }}>
                  <Text style={styles.notifHintText}>• Added a 'What’s New' banner on the home screen to highlight recent changes</Text>
                  <Text style={styles.notifHintText}>• Added a notification reminder banner if notifications are turned off</Text>
                  <Text style={styles.notifHintText}>• Added a quick 'Event Setup' shortcut from the 'Next Events' section</Text>
                </View>

                <Text style={styles.modalHint}>Improvements</Text>
                <View style={{ gap: 4 }}>
                  <Text style={styles.notifHintText}>• Unified banner styling with a darker, softer design</Text>
                  <Text style={styles.notifHintText}>• Reduced visual clutter and improved text hierarchy</Text>
                  <Text style={styles.notifHintText}>• Removed the clock rotation button from the home screen (still available in 'Settings')</Text>
                </View>
              </View>

              <View style={styles.modalSection}>
                <Text style={styles.modalSectionTitle}>January 2026 – Visual Polish &amp; Stability</Text>
                <Text style={[styles.notifHintText, { marginBottom: 10 }]}>
                  This update focused on making the app feel smoother and more consistent.
                </Text>

                <Text style={styles.modalHint}>Improvements</Text>
                <View style={{ gap: 4 }}>
                  <Text style={styles.notifHintText}>• Refined the home screen layout so the clock feels like the main focus</Text>
                  <Text style={styles.notifHintText}>• Improved animations for a calmer, more “cosy” feel</Text>
                  <Text style={styles.notifHintText}>• Cleaned up event lists and spacing for better readability</Text>
                </View>
              </View>

              <View style={styles.modalSection}>
                <Text style={styles.modalSectionTitle}>January 2026 – Notifications &amp; Platform Improvements</Text>
                <Text style={[styles.notifHintText, { marginBottom: 10 }]}>
                  Behind-the-scenes work to make reminders behave properly.
                </Text>

                <Text style={styles.modalHint}>What’s new</Text>
                <View style={{ gap: 4, marginBottom: 10 }}>
                  <Text style={styles.notifHintText}>• Added further support for event notifications</Text>
                  <Text style={styles.notifHintText}>• Notifications are now off by default and only request permission when enabled</Text>
                </View>

                <Text style={styles.modalHint}>Fixes &amp; improvements</Text>
                <View style={{ gap: 4 }}>
                  <Text style={styles.notifHintText}>• Improved Android notification reliability</Text>
                  <Text style={styles.notifHintText}>• Fixed navigation bar and layout issues on Android</Text>
                  <Text style={styles.notifHintText}>• Improved handling of alarms and reminders</Text>
                </View>
              </View>

              <View style={styles.modalSection}>
                <Text style={styles.modalSectionTitle}>December 2025 – Core Features</Text>
                <Text style={[styles.notifHintText, { marginBottom: 10 }]}>
                  The foundation of the app.
                </Text>

                <Text style={styles.modalHint}>What’s new</Text>
                <View style={{ gap: 4 }}>
                  <Text style={styles.notifHintText}>• Added the in-game Palia clock with day, evening, and night phases</Text>
                  <Text style={styles.notifHintText}>• Added event tracking and countdowns</Text>
                  <Text style={styles.notifHintText}>• Added the 'Next Events' list to the home screen to show what’s coming up next</Text>
                  <Text style={styles.notifHintText}>• Added custom events</Text>
                </View>
              </View>

              <View style={styles.modalSection}>
                <Text style={styles.modalSectionTitle}>Early Development</Text>
                <Text style={[styles.notifHintText, { marginBottom: 10 }]}>
                  The very beginning.
                </Text>

                <View style={{ gap: 4 }}>
                  <Text style={styles.notifHintText}>• Initial release of the Palia Event Tracker</Text>
                  <Text style={styles.notifHintText}>• Focused on accuracy, timing, and core functionality</Text>
                </View>
              </View>
</ScrollView>
          </View>
        </View>
      </Modal>


{/* SECTION 19.10) Status bar */}

      <ExpoStatusBar style="light" />
    </View>
  );
}





// SECTION 20) STYLES

// SECTION 20.1) Shared constants

const CARD_R = 12;

// Android modals with statusBarTranslucent render under the status bar.
// Offset the drawer sheet itself so the header never clips.
const ANDROID_STATUS_H = Platform.OS === "android" ? (StatusBar.currentHeight ?? 0) : 0;
const DRAWER_SHEET_TOP = Platform.OS === "android" ? ANDROID_STATUS_H + 8 : 10;

// Android navigation bar clearance.
// We lift the whole drawer sheet, not just the footer text.
const DRAWER_SHEET_BOTTOM = Platform.OS === "android" ? 50 : 0;

// Extra breathing room inside the footer (small, because the sheet is already lifted).
const DRAWER_FOOTER_EXTRA = Platform.OS === "android" ? 10 : 0;

// SECTION 20.2) App styles

const makeStyles = (scale: number) => {
  const t = (n: number) => Math.round(n * scale);
  return StyleSheet.create({
// SECTION 20.3) Root + scrolling

  root: { flex: 1, backgroundColor: BG_BASE },

  scrollContent: { paddingTop: 48, paddingHorizontal: 16, paddingBottom: 24 },

// SECTION 20.4) Header

  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  headerSlot: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },

  titleCard: {
    height: 44,
    paddingHorizontal: 18,
    borderRadius: CARD_R,
    backgroundColor: "rgba(10, 12, 11, 0.52)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    alignItems: "center",
    justifyContent: "center",
  },
  screenTitle: { color: SOFT_WHITE, fontSize: 24, fontWeight: "900", fontFamily: FONT_ROUNDED, letterSpacing: 0.4 },

// SECTION 20.5) Header buttons

  menuBtn: {
    width: 44,
    height: 44,
    borderRadius: CARD_R,
    backgroundColor: "rgba(10, 12, 11, 0.52)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    alignItems: "center",
    justifyContent: "center",
  },

  cogBtn: {
    width: 44,
    height: 44,
    borderRadius: CARD_R,
    backgroundColor: "rgba(10, 12, 11, 0.52)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    alignItems: "center",
    justifyContent: "center",
  },

// SECTION 20.6) Cards

  card: {
    backgroundColor: "rgba(10, 12, 11, 0.6)", // was 0.52 (more opaque = less starfield bleed)
    borderRadius: CARD_R,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    padding: 14,
    marginBottom: 12,
  },
  cardClock: { paddingBottom: 16 },
  cardReal: { paddingVertical: 12 },

// SECTION 20.6.X) Home banners

  bannerCard: {
    borderRadius: CARD_R,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    backgroundColor: "rgba(10, 12, 11, 0.52)",
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },

  bannerCardWarn: {
    borderColor: `rgba(${ACCENT_RGB},0.22)`,
    backgroundColor: `rgba(${ACCENT_RGB},0.10)`,
  },

  bannerLeft: { flex: 1, minWidth: 0 },

  bannerKicker: {
    color: ACCENT,
    fontWeight: "900",
    fontSize: t(11),
    letterSpacing: t(1.6),
    fontFamily: FONT_ROUNDED,
    marginBottom: 4,
  },

  bannerTitle: {
    color: SOFT_WHITE,
    fontWeight: "900",
    fontSize: t(13),
    fontFamily: FONT_ROUNDED,
    marginBottom: 2,
  },

  bannerSub: {
    color: SOFT_WHITE_DIM,
    fontWeight: "800",
    fontSize: t(11),
    lineHeight: t(14),
    fontFamily: FONT_ROUNDED,
  },
  bannerSubGold: {
    marginTop: 4,
    // Gold, but intentionally subdued so it doesn't overpower the actual update bullets
    color: `rgba(${ACCENT_RGB},0.55)`,
    fontWeight: "700",
    fontSize: t(11),
    lineHeight: t(15),
    fontFamily: FONT_ROUNDED,
  },


  bannerBullet: {
    marginTop: 4,
    color: SOFT_WHITE_DIM,
    fontWeight: "700",
    fontSize: t(12),
    lineHeight: t(16),
    fontFamily: FONT_ROUNDED,
  },

  bannerX: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
    backgroundColor: "rgba(255,255,255,0.04)",
    alignItems: "center",
    justifyContent: "center",
  },

// SECTION 20.7) Clock header + rotate toggle

  clockLabelRow: { position: "relative", alignItems: "center", justifyContent: "center", marginBottom: 0, minHeight: 34 },
  clockLabel: {
    color: ACCENT,
    fontWeight: "900",
    fontSize: t(12),
    letterSpacing: t(2),
    textAlign: "center",
    fontFamily: FONT_ROUNDED,
  },

  // Right-side action slot (refresh etc.)
  clockLabelActions: {
    position: "absolute",
    right: 0,
    top: 0,
    height: 34,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
  },

  // Left-side action slot (rotate toggle)
  clockLabelLeft: {
    position: "absolute",
    left: 0,
    top: 0,
    height: 34,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
  },

  clockIconBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
    backgroundColor: "rgba(255,255,255,0.04)",
    alignItems: "center",
    justifyContent: "center",
  },

  rotateBtn: {
    position: "absolute",
    right: 0,
    top: 0,
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
    backgroundColor: "rgba(255,255,255,0.04)",
    alignItems: "center",
    justifyContent: "center",
  },
  rotateBtnOn: { borderColor: `rgba(${ACCENT_RGB},0.30)`, backgroundColor: `rgba(${ACCENT_RGB},0.12)` },
  rotateIcon: { includeFontPadding: false, textAlignVertical: "center" },
  clockWrap: { width: "100%", alignItems: "center", justifyContent: "center" },

  // Clock view switcher (eye + segmented options) that lives UNDER the clock
  clockViewRow: {
    width: "100%",
    flexDirection: "row",
    justifyContent: "flex-start",
    marginTop: 10,
    marginBottom: 2,
  },

  clockViewGroup: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
    overflow: "hidden",
  },

  clockViewGroupOpen: {
    backgroundColor: "rgba(255,255,255,0.08)",
    borderColor: `rgba(${ACCENT_RGB},0.22)`,
  },

  clockViewEyeBtn: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
  },

  clockViewEyeBtnOpen: {
    borderRightWidth: 1,
    borderRightColor: "rgba(255,255,255,0.14)",
  },

  clockViewOptions: {
    flexDirection: "row",
    alignItems: "center",
  },

  clockViewOptionItem: {
    paddingHorizontal: 10,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
  },

  clockViewOptionItemOn: {
    backgroundColor: `rgba(${ACCENT_RGB},0.18)`,
  },

  clockViewOptionText: {
    fontSize: t(12),
    fontWeight: "800",
    color: SOFT_WHITE_DIM,
    fontFamily: FONT_ROUNDED,
  },

  clockViewOptionTextOn: {
    color: ACCENT,
  },

// SECTION 20.8) Time-of-day strip

  timeOfDayRow: { flexDirection: "row", justifyContent: "center", alignItems: "center", marginTop: 16, marginBottom: 2 },
  timeOfDayChip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 14, borderWidth: 1, borderColor: "transparent" },
  timeOfDayChipOn: {
    // Active filter chip: subtle gold wash + thin gold outline
    backgroundColor: `rgba(${ACCENT_RGB},0.15)`,
    borderColor: `rgba(${ACCENT_RGB},0.35)`,
  },
  timeOfDayText: { color: "rgba(252,248,240,0.45)", fontWeight: "900", fontSize: t(12), fontFamily: FONT_ROUNDED },
  timeOfDayTextActive: { color: ACCENT, opacity: 1 },
  timeOfDayDot: {
    color: "rgba(252,248,240,0.55)",
    marginHorizontal: 10,
    fontWeight: "900",
    fontSize: t(12),
    includeFontPadding: false,
    textAlignVertical: "center",
  },

// SECTION 20.9) Next card

  nextCard: {
    marginTop: 8,
    padding: 12,
    borderRadius: CARD_R,

    // Outer card surface (keep it subtle so gaps between pills don't read as a second panel)
    backgroundColor: "rgba(255,255,255,0.018)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",

    shadowColor: "rgba(0,0,0,0)",
    shadowOpacity: 0.12,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },

  nextHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },

  nextHeaderLeft: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 8,
    flex: 1,
    paddingRight: 10,
  },

  nextHeaderRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },

  nextTitle: { color: SOFT_WHITE, fontWeight: "900", fontSize: t(14), fontFamily: FONT_ROUNDED },

  // Warm accent “key label”
  nextMeta: { color: ACCENT, fontWeight: "900", fontSize: t(13), fontFamily: FONT_ROUNDED, opacity: 0.95 },

  nextPill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: `rgba(${ACCENT_RGB},0.10)`,
    borderWidth: 1,
    borderColor: `rgba(${ACCENT_RGB},0.18)`,
    alignSelf: "center",
  },
  nextPillText: {
    color: ACCENT,
    fontWeight: "900",
    fontSize: t(12),
    fontFamily: FONT_ROUNDED,
    includeFontPadding: false,
  },

  nextList: { marginTop: 10 },

  // Fish view: 3-column grid cards (used in both Now + Next)
  fishGrid: {
    marginTop: 10,
    flexDirection: "row",
    flexWrap: "wrap",
    marginHorizontal: -4,
  },

  fishCell: {
    width: "33.3333%",
    paddingHorizontal: 4,
    paddingBottom: 8,
  },

  fishCard: {
    // +50% vertical height (was 92)
    minHeight: 138,
    borderRadius: 12,
    padding: 10,
    backgroundColor: "rgba(255,255,255,0.050)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
    overflow: "hidden",
  },


  fishCardInner: {
    flex: 1,
    justifyContent: "space-between",
  },

  fishImageSlot: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.055)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    overflow: "hidden",
  },

  fishImage: {
    width: "100%",
    height: "100%",
    resizeMode: "cover",
  },

  fishBottomBlock: {
    marginTop: 8,
  },
  fishTopRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 8,
  },

  fishTitle: {
    color: SOFT_WHITE,
    fontWeight: "900",
    fontSize: t(12),
    lineHeight: t(15),
    fontFamily: FONT_ROUNDED,
  },

  fishBellBtn: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.055)",
    alignItems: "center",
    justifyContent: "center",
  },

  fishSub: {
    marginTop: 4,
    color: SOFT_WHITE_FAINT,
    fontWeight: "800",
    fontSize: t(10.5),
    lineHeight: t(13),
    fontFamily: FONT_ROUNDED,
  },

  fishMetaRow: {
    marginTop: 8,
  },

  fishMetaText: {
    color: ACCENT,
    fontWeight: "900",
    fontSize: t(10.5),
    fontFamily: FONT_ROUNDED,
  },

  fishCountdownPill: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.055)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },

  fishCountdownText: {
    color: SOFT_WHITE_DIM,
    fontWeight: "900",
    fontSize: t(10.5),
    fontFamily: FONT_ROUNDED,
    includeFontPadding: false,
  },

  nextGroup: { marginBottom: 12 },

  nextGroupHeader: {
    color: "rgba(252,248,240,0.66)",
    fontWeight: "900",
    fontSize: t(12),
    fontFamily: FONT_ROUNDED,
    letterSpacing: t(0.4),
    marginBottom: 6,
  },

  nextRow: {
    position: "relative",

    flexDirection: "row",
    alignItems: "center",
    gap: 10,

    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 12,

    // Individual pill surface
    backgroundColor: "rgba(255,255,255,0.050)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",

    marginTop: 6,
  },

  nextIconWrap: {
    width: 24,
    height: 24,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.055)",
  },

  nextRowTextCol: { flex: 1, minWidth: 0 },

  nextRowTitle: {
    color: SOFT_WHITE,
    fontWeight: "900",
    fontSize: t(13),
    fontFamily: FONT_ROUNDED,
  },

  nextRowSub: {
    marginTop: 2,
    color: SOFT_WHITE_FAINT,
    fontWeight: "800",
    fontSize: t(11),
    lineHeight: t(14),
    fontFamily: FONT_ROUNDED,
  },

  // "Now" right-side mini column (End time)

  nextRowRight: { flexDirection: "row", alignItems: "center" },

  nextBellChip: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 0,
    backgroundColor: "rgba(255,255,255,0.055)",
    alignItems: "center",
    justifyContent: "center",
  },

  // "Now" right-side mini column (End time)
  nowRight: { alignItems: "flex-end", justifyContent: "center", minWidth: 54 },
  nowRightRow: { flexDirection: "row", alignItems: "center", gap: 8 },

  nowBellChip: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 0,
    backgroundColor: "rgba(255,255,255,0.055)",
    alignItems: "center",
    justifyContent: "center",
  },
  nowEndTime: { color: SOFT_WHITE, fontWeight: "900", fontSize: t(12), fontFamily: FONT_ROUNDED },


  nowCountdownWrap: { marginTop: 10, marginBottom: 4 },
  nowBarRow: { flexDirection: "row", alignItems: "center", gap: 8 },

  nowProgressTrack: {
    flex: 1,
    height: 4,
    borderRadius: 999,
    overflow: "hidden",
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  nowProgressFill: {
    height: 4,
    borderRadius: 999,
    backgroundColor: `rgba(${ACCENT_RGB},0.85)`,
  },

  nowRowStar: {
    position: "absolute",
    top: 6,
    left: 6,
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
    pointerEvents: "none",
  },

  nextEmpty: {
    color: SOFT_WHITE_FAINT,
    fontWeight: "900",
    fontSize: t(13),
    lineHeight: t(18),
    fontFamily: FONT_ROUNDED,
  },


  nextSetupBtn: {
    marginTop: 10,
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: `rgba(${ACCENT_RGB},0.14)`,
    borderWidth: 1,
    borderColor: `rgba(${ACCENT_RGB},0.28)`,
  },

  nextSetupBtnText: {
    color: SOFT_WHITE,
    fontWeight: "900",
    fontSize: t(12),
    letterSpacing: t(0.3),
    fontFamily: FONT_ROUNDED,
  },


// SECTION 20.10) Editing state pill

  editingPill: {
    marginTop: 10,
    backgroundColor: `rgba(${ACCENT_RGB},0.14)`,
    borderWidth: 1,
    borderColor: `rgba(${ACCENT_RGB},0.22)`,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    alignSelf: "center",
  },
  editingPillText: { color: ACCENT, fontWeight: "900", fontSize: t(12), letterSpacing: t(1), fontFamily: FONT_ROUNDED },

// SECTION 20.11) Card headers

  cardHeaderRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 },
  cardTitle: { color: SOFT_WHITE, fontSize: t(16), fontWeight: "900", fontFamily: FONT_ROUNDED },
  cardSubtitle: { color: SOFT_WHITE_DIM, fontSize: t(12), fontWeight: "800", fontFamily: FONT_ROUNDED },

// SECTION 20.12) Buttons

  smallGhost: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  smallGhostText: { color: SOFT_WHITE_DIM, fontWeight: "900", fontSize: t(12), fontFamily: FONT_ROUNDED },

  // icon + label inside pill buttons (no `gap`, because RN loves chaos)
  smallGhostRow: { flexDirection: "row", alignItems: "center" },

  // Folder bulk action row (Enable/Disable all + Mute/Unmute all + Sort)
  folderBulkRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "flex-start",

    // Breathing room so chips don't feel glued to the header or first row
    marginTop: 12,
    marginBottom: 10,

    // Keep wrapping tidy without visual “stair-steps”
    marginRight: -8,
  },

  folderBulkLeft: { flexDirection: "row", flexWrap: "wrap", alignItems: "center" },
  folderBulkRight: { marginLeft: "auto" },
  folderBulkBtn: { marginRight: 8, marginBottom: 8 },

  // Cozy folder action chips (lighter than “control panel” buttons)
  actionChip: {
    flexDirection: "row",
    alignItems: "center",
    height: 28,
    paddingHorizontal: 10,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    marginRight: 8,
    marginBottom: 14,
  },
  actionChipDisabled: {
    opacity: 0.45,
  },
  actionChipText: {
    marginLeft: 6,
    color: SOFT_WHITE,
    fontSize: t(12),
    fontWeight: "700",
  },

  folderHeaderSticky: {
    paddingTop: 6,
    paddingBottom: 2,
    backgroundColor: "transparent",
  },



// SECTION 20.13) Inputs

  input: {
    backgroundColor: "rgba(255,255,255,0.04)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 12,
    color: SOFT_WHITE,
    fontWeight: "900",
    fontFamily: FONT_ROUNDED,
  },
  notesInput: {
    minHeight: 90,
    paddingTop: 12,
    paddingBottom: 12,
    fontWeight: "800",
  },
  inputLabel: { color: SOFT_WHITE_DIM, fontWeight: "900", marginTop: 10, marginBottom: 14, fontFamily: FONT_ROUNDED },
  fieldLabel: { color: SOFT_WHITE_DIM, fontWeight: "900", fontSize: t(11), marginBottom: 14, fontFamily: FONT_ROUNDED },

  // Folder row in setup
  folderRow: {
    // Unified header pill (compact, readable)
    minHeight: 50,
    paddingVertical: 10,
    paddingHorizontal: 14,

    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.03)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",

    justifyContent: "center",
  },

  folderRowOn: {
    borderColor: `rgba(${ACCENT_RGB},0.28)`,
    backgroundColor: `rgba(${ACCENT_RGB},0.10)`,
  },
  folderRowLabel: { color: SOFT_WHITE, fontWeight: "900", fontSize: t(12), marginBottom: 10, fontFamily: FONT_ROUNDED },

  // "Add marker" / "Edit marker" form rows
  setupRow: {
    marginTop: 10,
    padding: 12,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.03)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },

  // Open body of the Add/Edit dropdown
  addDropdown: {
    marginTop: 10,
    padding: 12,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.03)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },

  rowHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  rowHeaderTitle: { color: SOFT_WHITE, fontWeight: "900", fontSize: t(12), fontFamily: FONT_ROUNDED },

  // Add marker button in folder header
  addMarkerBtn: {
    // Unified header pill sizing (matches folder rows)
    minHeight: 50,
    paddingVertical: 10,
    paddingHorizontal: 14,

    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
    backgroundColor: "rgba(255,255,255,0.04)",

    justifyContent: "center",
  },
  addMarkerBtnOn: {
    borderColor: `rgba(${ACCENT_RGB},0.28)`,
    backgroundColor: `rgba(${ACCENT_RGB},0.10)`,
  },
  addMarkerBtnText: {
    color: SOFT_WHITE,
    fontWeight: "900",
    fontSize: t(13),
    letterSpacing: t(0.4),
    fontFamily: FONT_ROUNDED,
    textAlignVertical: "center",
  },
  addMarkerBtnTextOn: { color: ACCENT },

  // Location select button
  locationBox: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.04)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  locationBoxOn: {
    borderColor: `rgba(${ACCENT_RGB},0.28)`,
    backgroundColor: `rgba(${ACCENT_RGB},0.08)`,
  },
  locationSelectText: { color: SOFT_WHITE, fontWeight: "900", fontFamily: FONT_ROUNDED },
  locationSelectTextGhost: { color: SOFT_WHITE_GHOST },

  // Time select boxes
  timeBoxesRow: { flexDirection: "row", gap: 10 },
  timeBox: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.04)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  timeBoxOn: {
    borderColor: `rgba(${ACCENT_RGB},0.28)`,
    backgroundColor: `rgba(${ACCENT_RGB},0.08)`,
  },
  timeBoxLabel: { color: SOFT_WHITE_DIM, fontWeight: "900", fontSize: t(11), fontFamily: FONT_ROUNDED },
  timeBoxValue: { color: SOFT_WHITE, fontWeight: "900", fontFamily: FONT_ROUNDED },
  timeColon: { color: SOFT_WHITE_DIM, fontWeight: "900", fontFamily: FONT_ROUNDED },
  timeSelectTextGhost: { color: SOFT_WHITE_GHOST },

  // Wheel options
  timeWheelWrap: {
    marginTop: 12,
    flexDirection: "row",
    gap: 10,
  },

  // Alias: used by the wheel pickers in the Add/Edit form
  timePickersWrap: {
    marginTop: 12,
    flexDirection: "row",
    gap: 10,
  },

  timeWheel: {
    flex: 1,
    height: 150,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    backgroundColor: "rgba(255,255,255,0.03)",
    overflow: "hidden",
  },
  timeWheelRow: {
    height: 30,
    justifyContent: "center",
    alignItems: "center",
  },
  timeWheelHighlight: {
    position: "absolute",
    left: 8,
    right: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: `rgba(${ACCENT_RGB},0.22)`,
    backgroundColor: `rgba(${ACCENT_RGB},0.10)`,
  },
  timeWheelHighlightGhost: {
    borderColor: "rgba(255,255,255,0.10)",
    backgroundColor: "rgba(255,255,255,0.03)",
  },
  timeWheelText: {
    color: SOFT_WHITE_DIM,
    fontWeight: "900",
    fontSize: t(16),
    lineHeight: t(20),
    fontFamily: FONT_ROUNDED,
    includeFontPadding: false,
  },
  timeWheelTextOn: { color: SOFT_WHITE },

  // Folder dropdown container (used by renderFolderDropdown)
  timeDropdown: {
    marginTop: 6,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    backgroundColor: "rgba(255,255,255,0.03)",
    overflow: "hidden",
  },

  // Location wheel (grouped)
  locationWheel: {
    flex: 1,
    height: 180,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    backgroundColor: "rgba(255,255,255,0.03)",
    overflow: "hidden",
  },
  locationOptRow: {
    justifyContent: "center",
    alignItems: "center",
  },
  locationGroupText: {
    color: SOFT_WHITE_FAINT,
    fontWeight: "900",
    fontSize: t(12),
    letterSpacing: t(0.6),
    fontFamily: FONT_ROUNDED,
  },
  locationOptRowSub: { opacity: 0.75 },

  // Time options (dropdown rows)
  timeOpt: {
    justifyContent: "center",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.04)",
  },
  timeOptText: {
    color: SOFT_WHITE_DIM,
    fontWeight: "900",
    fontSize: t(16),
    fontFamily: FONT_ROUNDED,
    includeFontPadding: false,
  },
  timeOptTextOn: { color: SOFT_WHITE },

  // Location options (fallback list)
  locationHighlight: {
    backgroundColor: `rgba(${ACCENT_RGB},0.10)`,
    borderColor: `rgba(${ACCENT_RGB},0.22)`,
  },
  locationOptText: { color: SOFT_WHITE_DIM, fontWeight: "900", fontFamily: FONT_ROUNDED, fontSize: t(16), lineHeight: t(20) },
  locationSubText: { fontSize: t(14), lineHeight: t(18) },

  // Primary action (save marker)
  durationChipsRow: { flexDirection: "row", gap: 10, marginTop: 8 },
  durationChip: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.03)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    alignItems: "center",
    justifyContent: "center",
  },
  durationChipOn: { borderColor: `rgba(${ACCENT_RGB},0.30)`, backgroundColor: `rgba(${ACCENT_RGB},0.12)` },
  durationChipText: { color: SOFT_WHITE_FAINT, fontWeight: "900", fontSize: t(12), fontFamily: FONT_ROUNDED },
  durationChipTextOn: { color: ACCENT, opacity: 1 },

  saveMarkerBtn: {
    marginTop: 12,
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: "center",
    backgroundColor: `rgba(${ACCENT_RGB},0.20)`,
    borderWidth: 1,
    borderColor: `rgba(${ACCENT_RGB},0.35)`,
  },
  saveMarkerBtnDisabled: { opacity: 0.40 },
  saveMarkerBtnText: { color: ACCENT, fontWeight: "900", fontSize: t(14), fontFamily: FONT_ROUNDED },

// SECTION 20.14) Segmented controls

  segment: {
    flexDirection: "row",
    backgroundColor: "rgba(255,255,255,0.04)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    borderRadius: 999,
    padding: 6,
  },
  segmentBtn: { flex: 1, paddingVertical: 10, borderRadius: 999, alignItems: "center", marginHorizontal: 4 },
  segmentBtnActive: { backgroundColor: "rgba(255,255,255,0.08)" },
  segmentText: { color: SOFT_WHITE_DIM, fontWeight: "900", fontSize: t(12), fontFamily: FONT_ROUNDED },
  segmentTextActive: { color: SOFT_WHITE },

// SECTION 20.15) Marker rows

  markerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    paddingHorizontal: 14,

    // Cozy “pill card” (no Android blue glass)
    backgroundColor: "rgba(255,255,255,0.045)",
    borderWidth: 0,
borderRadius: 14,
    overflow: "hidden",

    // Keep shadows off to avoid odd native tinting
    shadowColor: "transparent",
    shadowOpacity: 0,
    shadowRadius: 0,
    shadowOffset: { width: 0, height: 0 },
    elevation: 0,
  },

  markerRowDisabled: { opacity: 0.62 },

  // Inline notes dropdown under an event row (Event Setup)
  eventNotesDrop: {
    marginTop: 8,
    // Match the event card width (same left/right edges as the row above)
    marginLeft: 0,
    marginRight: 0,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.03)",
    borderWidth: 1,
    borderColor: `rgba(${ACCENT_RGB},0.22)`,
  },
  eventNotesLabel: {
    color: ACCENT,
    fontWeight: "900",
    fontSize: t(11),
    letterSpacing: 1,
    opacity: 0.9,
    marginBottom: 6,
    fontFamily: FONT_ROUNDED,
  },
  eventNotesText: {
    color: SOFT_WHITE_DIM,
    fontSize: t(12),
    lineHeight: t(16),
    fontFamily: FONT_ROUNDED,
  },

  checkBox: {
    width: 22,
    height: 22,
    borderRadius: 7,

    // No outline, just a slightly different tone
    borderWidth: 0,
    backgroundColor: "rgba(255,255,255,0.065)",

    alignItems: "center",
    justifyContent: "center",
  },
  checkBoxOn: {
    // Gold-tinted fill (not status green)
    backgroundColor: `rgba(${ACCENT_RGB},0.16)`,
  },
  checkMark: { color: ACCENT, fontWeight: "900", fontSize: t(14), includeFontPadding: false },

  markerTextCol: { flex: 1, marginLeft: 10, marginRight: 10 },
  markerName: { color: SOFT_WHITE, fontWeight: "900", fontSize: t(14), lineHeight: t(18), fontFamily: FONT_ROUNDED },
  markerLocation: { color: SOFT_WHITE_FAINT, fontSize: t(11), marginTop: 2, lineHeight: t(14), fontFamily: FONT_ROUNDED },
  dimText: { opacity: 0.6 },

  markerTimeRow: { flexDirection: "row", alignItems: "center", marginTop: 6, gap: 8 },
  markerTimeText: { color: SOFT_WHITE_DIM, fontWeight: "900", fontSize: t(12), lineHeight: t(14), fontFamily: FONT_ROUNDED },

  countdownPill: {
    height: 24,
    paddingHorizontal: 10,
    borderRadius: 999,

    // Tone-based chip, no outline/no extra shadow
    borderWidth: 0,
    backgroundColor: `rgba(${ACCENT_RGB},0.10)`,

    alignItems: "center",
    justifyContent: "center",
  },
  countdownPillOff: { backgroundColor: "rgba(255,255,255,0.05)" },
  countdownPillText: { color: SOFT_WHITE, fontWeight: "900", fontFamily: FONT_ROUNDED },

  markerActionsRow: { flexDirection: "row", alignItems: "center", gap: 8 },

  // Same-size icon chips (edit / notify / delete)
  actionIconChip: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 0,
    backgroundColor: "rgba(255,255,255,0.055)",
    alignItems: "center",
    justifyContent: "center",
  },

  // Notify uses the same base size, just different “on” tint
  notifyIconChip: {},
  notifyIconChipOn: { backgroundColor: `rgba(${ACCENT_RGB},0.18)` },
  notifyIconChipOff: { backgroundColor: "rgba(255,255,255,0.045)" },

  // Delete stays calm (no red panic), just a tiny tone difference if you want later
  deleteIconChip: {},

  notifyChipText: { color: SOFT_WHITE, fontWeight: "900", fontSize: t(12), includeFontPadding: false },
  deleteChipText: { color: SOFT_WHITE, fontWeight: "900", fontSize: t(12), includeFontPadding: false },

// SECTION 20.16) Notification toggle (removed from home screen)

// SECTION 20.16) Notification toggle (removed from home screen)

  // Notifications UI is handled in the Settings modal now.

// SECTION 20.17) Reminder controls

  reminderPills: {
    flexDirection: "row",
    flexWrap: "wrap",
  },
  reminderPill: {
    height: 34,
    paddingHorizontal: 11.75,
    borderRadius: 999,

    // Center the label vertically + horizontally inside each pill
    alignItems: "center",
    justifyContent: "center",

    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",

    marginRight: 8,
    marginBottom: 14,
  },
  reminderPillOn: { borderColor: `rgba(${ACCENT_RGB},0.35)`, backgroundColor: `rgba(${ACCENT_RGB},0.14)` },
  reminderPillDisabled: {
    opacity: 0.35,
  },
  reminderPillText: {
    color: SOFT_WHITE_DIM,
    fontWeight: "900",
    fontSize: t(12),
    lineHeight: t(12),
    textAlign: "center",
    fontFamily: FONT_ROUNDED,
  },
  reminderPillTextOn: { color: ACCENT },
  reminderPillTextDisabled: {
    color: "rgba(255,255,255,0.22)",
  },

// SECTION 20.18) Modal

  // Side drawer
  drawerRoot: { flex: 1, justifyContent: "flex-start" },

  drawerBackdrop: {
    ...StyleSheet.absoluteFillObject,
  },

  backdropDimSoft: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  backdropDimHard: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.55)",
  },

  drawerSheet: {
    // ✅ Use absolute top/bottom (set inline) instead of % height + margins
    position: "absolute",
    left: 8,
    borderRadius: 22,
    backgroundColor: "rgba(10,12,11,0.96)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    overflow: "hidden",
  },

  drawerHeader: {
    height: 50, // tidy header
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.08)",
  },

  drawerTitle: {
    color: SOFT_WHITE,
    fontSize: t(22),
    fontWeight: "800",
    letterSpacing: t(0.3),
  },

  drawerClose: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },

  drawerBody: {
    flex: 1,
    padding: 14,
  },

  // Alias for JSX usage (kills the red line)
  drawerItem: {
    height: 56,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    backgroundColor: "rgba(255,255,255,0.03)",
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },

  drawerItemText: {
    color: SOFT_WHITE,
    fontSize: t(16),
    fontWeight: "700",
  },

  drawerFooter: {
    paddingTop: 15,
    paddingBottom: 20, // ✅ bottom clearance is handled by sheet bottom inset now
    paddingHorizontal: 14,
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.08)",
  },

  drawerFooterText: {
    color: "rgba(255,255,255,0.40)",
    fontSize: t(14),
    fontWeight: "700",
  },

// Settings modal

  modalBackdrop: { ...StyleSheet.absoluteFillObject, justifyContent: "flex-end" },
  modalBackdropPress: { ...StyleSheet.absoluteFillObject },

  // Closed test notice (shown once)

  ctBackdrop: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
  ctBackdropPress: { ...StyleSheet.absoluteFillObject },

  ctCard: {
    width: "86%",
    maxWidth: 520,
    backgroundColor: "rgba(10,12,11,0.96)",
    borderRadius: 22,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    padding: 16,
  },

  ctTitle: {
    color: SOFT_WHITE,
    fontWeight: "900",
    fontSize: t(18),
    fontFamily: FONT_ROUNDED,
    marginBottom: 8,
    includeFontPadding: false,
    textAlign: "center",
  },

  ctText: {
    color: SOFT_WHITE_DIM,
    fontSize: t(13),
    lineHeight: t(18),
    fontWeight: "700",
    fontFamily: FONT_ROUNDED,
    textAlign: "center",
  },

  ctTextStrong: { color: ACCENT, fontWeight: "900" },

  ctBtnRow: { flexDirection: "row", justifyContent: "center", marginTop: 14 },

  ctBtn: {
    minWidth: 120,
    height: 34,
    paddingHorizontal: 14,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: `rgba(${ACCENT_RGB},0.18)`,
    borderWidth: 1,
    borderColor: `rgba(${ACCENT_RGB},0.35)`,
  },

  ctBtnText: {
    color: ACCENT,
    fontWeight: "900",
    fontSize: t(13),
    fontFamily: FONT_ROUNDED,
    includeFontPadding: false,
  },

  modalSheet: {
    backgroundColor: "rgba(10,12,11,0.96)",
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    overflow: "hidden",
  },

  modalHeader: {
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 10,
    minHeight: 74,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.08)",
  },

  
    modalTitleRow: {
      flexDirection: "row",
      alignItems: "center",
    },
    modalTitleIconWrap: {
      width: 22,
      height: 22,
      alignItems: "center",
      justifyContent: "center",
      marginRight: 8,
    },
modalTitle: {
    color: SOFT_WHITE,
    fontWeight: "900",
    fontSize: t(16),
    fontFamily: FONT_ROUNDED,
    includeFontPadding: false,
  },

  modalClose: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },

  modalHeaderRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },

  textSizeHeader: {
    alignItems: "flex-end",
    justifyContent: "center",
  },

  textSizeHeaderLabel: {
    color: SOFT_WHITE_DIM,
    fontSize: t(11),
    fontWeight: "900",
    fontFamily: FONT_ROUNDED,
    letterSpacing: t(0.6),
    marginBottom: 6,
    includeFontPadding: false,
  },

  textSizeHeaderPills: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },

  textSizePill: {
    paddingHorizontal: 12,
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
    backgroundColor: "rgba(255,255,255,0.04)",
    alignItems: "center",
    justifyContent: "center",
  },

  textSizePillOn: {
    backgroundColor: `rgba(${ACCENT_RGB},0.18)`,
    borderColor: `rgba(${ACCENT_RGB},0.35)`,
  },

  textSizePillText: {
    color: SOFT_WHITE_DIM,
    fontSize: t(12),
    fontWeight: "900",
    fontFamily: FONT_ROUNDED,
    includeFontPadding: false,
  },

  textSizePillTextOn: {
    color: ACCENT,
  },

  modalContent: { padding: 14, paddingBottom: 28 },

  // Roadmap footer (outside the cards)
  roadmapFooterWrap: {
    paddingHorizontal: 14,
    paddingTop: 6,
  },

  roadmapFooterText: {
    color: "rgba(255,255,255,0.40)",
    fontSize: t(12),
    fontWeight: "800",
    fontFamily: FONT_ROUNDED,
    textAlign: "center",
    lineHeight: t(16),
  },

  modalSection: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    backgroundColor: "rgba(255,255,255,0.03)",
    padding: 12,
    marginBottom: 12,
  },

  
    modalSectionTitleRow: {
      flexDirection: "row",
      alignItems: "center",
      marginBottom: 10,
    },
    modalSectionTitleIconWrap: {
      width: 22,
      height: 22,
      alignItems: "center",
      justifyContent: "center",
      marginRight: 8,
    },
modalSectionTitle: {
    includeFontPadding: false,
    color: SOFT_WHITE,
    fontWeight: "900",
    fontSize: t(14),    fontFamily: FONT_ROUNDED,
  },

  // Gold titles for Settings cards (Display / Visibility / Notifications)
  settingsCardTitle: {
    color: ACCENT,
    fontWeight: "900",
    fontSize: t(13),
    marginBottom: 10,
    fontFamily: FONT_ROUNDED,
  },


// Clock Settings (sub-cards inside the Settings modal)
clockSettingsCard: {
  borderRadius: 14,
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.08)",
  backgroundColor: "rgba(10, 12, 11, 0.35)",
  padding: 10,
  marginBottom: 10,
},

clockSettingsSubTitle: {
  color: "rgba(255,255,255,0.55)",
  fontWeight: "900",
  fontSize: t(12),
  marginBottom: 8,
  fontFamily: FONT_ROUNDED,
  letterSpacing: t(0.2),
},


  modalHint: {
    color: SOFT_WHITE_DIM,
    fontWeight: "800",
    fontSize: t(12),
    marginBottom: 14,
    fontFamily: FONT_ROUNDED,
  },

  modalRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
    paddingVertical: 4,
  },

  modalRowOnAccent: {
    backgroundColor: `rgba(${ACCENT_RGB},0.08)`,
    borderRadius: 14,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },

  notifHintWrap: {
    marginTop: 6,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    backgroundColor: "rgba(255,255,255,0.03)",
    padding: 10,
  },

  notifHintText: {
    color: "rgba(245,250,255,0.72)",
    fontSize: t(12),
    lineHeight: t(16),
    fontFamily: FONT_ROUNDED,
    marginBottom: 14,
  },

  eventDetailsValue: {
    color: SOFT_WHITE,
    fontWeight: "900",
    fontSize: t(12),
    fontFamily: FONT_ROUNDED,
    includeFontPadding: false,
  },

  notifHintBtn: {
    alignSelf: "flex-start",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: `rgba(${ACCENT_RGB},0.16)`,
    borderWidth: 1,
    borderColor: `rgba(${ACCENT_RGB},0.30)`,
  },

  notifHintBtnText: {
    color: ACCENT,
    fontWeight: "900",
    fontSize: t(12),
    letterSpacing: t(0.3),
    fontFamily: FONT_ROUNDED,
  },

  helpButtonRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 2,
  },

  helpHalfBtn: {
    flex: 1,
  },

  helpActionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 10,
    backgroundColor: "rgba(255,255,255,0.03)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },

  helpActionText: {
    color: SOFT_WHITE,
    fontWeight: "900",
    fontSize: t(13),
    fontFamily: FONT_ROUNDED,
  },

  modalRowOnEnabled: {
    // Use gold accent (not "status green")
    backgroundColor: `rgba(${ACCENT_RGB},0.08)`,
    borderRadius: 14,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },

  modalRowLabel: { color: SOFT_WHITE, fontWeight: "900", fontFamily: FONT_ROUNDED },

  modalPill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
    backgroundColor: "rgba(255,255,255,0.04)",
  },

  modalPillOnAccent: { borderColor: `rgba(${ACCENT_RGB},0.35)`, backgroundColor: `rgba(${ACCENT_RGB},0.14)` },
  // Use gold accent (not "status green")
  modalPillOnEnabled: { borderColor: `rgba(${ACCENT_RGB},0.35)`, backgroundColor: `rgba(${ACCENT_RGB},0.14)` },

  modalPillText: { color: SOFT_WHITE_DIM, fontWeight: "900", fontSize: t(12), fontFamily: FONT_ROUNDED },
  modalPillTextOnAccent: { color: ACCENT },
  // Use gold accent (not "status green")
  modalPillTextOnEnabled: { color: ACCENT },

  nextCountSegment: {
    flexDirection: "row",
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
    overflow: "hidden",
  },

  // Home view picker segmented control (Events / Fish / Bugs)
  viewModeSegment: {
    flexDirection: "row",
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
    overflow: "hidden",
  },

  viewModeSegmentItem: {
    paddingHorizontal: 10,
    paddingVertical: 6,
  },

  viewModeSegmentItemOn: {
    backgroundColor: `rgba(${ACCENT_RGB},0.18)`,
  },

  viewModeSegmentText: {
    fontSize: t(12),
    fontWeight: "800",
    color: SOFT_WHITE_DIM,
    fontFamily: FONT_ROUNDED,
  },

  viewModeSegmentTextOn: {
    color: ACCENT,
  },


  nextCountSegmentItem: {
    paddingHorizontal: 8,
    paddingVertical: 6,
  },

  nextCountSegmentItemOn: {
    backgroundColor: `rgba(${ACCENT_RGB},0.18)`,
  },

  nextCountSegmentText: {
    fontSize: t(12),
    fontWeight: "800",
    color: SOFT_WHITE_DIM,
    fontFamily: FONT_ROUNDED,
  },

  nextCountSegmentTextOn: {
    color: ACCENT,
  },

  });
};