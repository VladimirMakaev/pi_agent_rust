/**
 * Pi Canvas - Interactive TUI canvases for Pi Coding Agent
 * 
 * Native pi TUI version - no tmux required!
 * Uses ctx.ui.custom() to render canvases inline.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

// ============================================
// Types
// ============================================

interface CalendarEvent {
  id: string;
  title: string;
  startTime: string; // ISO datetime
  endTime: string;
  color?: string;
  allDay?: boolean;
}

interface CalendarConfig {
  title?: string;
  events?: CalendarEvent[];
  weekOffset?: number; // 0 = current week, -1 = last week, 1 = next week
}

interface TimeSlot {
  date: string;
  hour: number;
  minute: number;
}

interface CalendarResult {
  action: "selected" | "cancelled";
  slot?: TimeSlot;
}

interface DocumentConfig {
  content: string;
  title?: string;
}

interface DocumentResult {
  action: "closed" | "selected";
  selection?: {
    text: string;
    startOffset: number;
    endOffset: number;
  };
  content?: string;
}

// Flight types
interface Airport {
  code: string;
  name: string;
  city: string;
}

interface Flight {
  id: string;
  airline: string;
  flightNumber: string;
  origin: Airport;
  destination: Airport;
  departureTime: string;
  arrivalTime: string;
  duration: number; // minutes
  price: number; // cents
  currency: string;
  stops: number;
  aircraft?: string;
}

interface FlightConfig {
  flights: Flight[];
  title?: string;
}

interface FlightResult {
  action: "selected" | "cancelled";
  flight?: Flight;
}

// ============================================
// Calendar Canvas Component
// ============================================

const START_HOUR = 6;
const END_HOUR = 22;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const COLORS: Record<string, string> = {
  blue: "\x1b[44m",
  green: "\x1b[42m",
  yellow: "\x1b[43m",
  red: "\x1b[41m",
  magenta: "\x1b[45m",
  cyan: "\x1b[46m",
};
const RESET = "\x1b[0m";

function getWeekDays(weekOffset: number = 0): Date[] {
  const today = new Date();
  const dayOfWeek = today.getDay();
  const monday = new Date(today);
  monday.setDate(today.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1) + weekOffset * 7);
  
  const days: Date[] = [];
  for (let i = 0; i < 7; i++) {
    const day = new Date(monday);
    day.setDate(monday.getDate() + i);
    days.push(day);
  }
  return days;
}

function formatDate(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function formatMonthYear(d: Date): string {
  const months = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  return `${months[d.getMonth()]} ${d.getFullYear()}`;
}

function isSameDay(d1: Date, d2: Date): boolean {
  return d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate();
}

function parseTime(iso: string): Date {
  return new Date(iso);
}

class CalendarCanvas {
  private config: CalendarConfig;
  private theme: Theme;
  private weekOffset: number;
  private selectedDay: number = 0;
  private selectedHour: number = 9;
  private onDone: (result: CalendarResult) => void;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(config: CalendarConfig, theme: Theme, onDone: (result: CalendarResult) => void) {
    this.config = config;
    this.theme = theme;
    this.weekOffset = config.weekOffset ?? 0;
    this.onDone = onDone;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q" || data === "Q") {
      this.onDone({ action: "cancelled" });
      return;
    }

    if (matchesKey(data, "enter")) {
      const weekDays = getWeekDays(this.weekOffset);
      const selectedDate = weekDays[this.selectedDay];
      this.onDone({
        action: "selected",
        slot: {
          date: selectedDate.toISOString().split("T")[0],
          hour: this.selectedHour,
          minute: 0,
        },
      });
      return;
    }

    // Navigation
    if (matchesKey(data, "left") || data === "h") {
      this.selectedDay = Math.max(0, this.selectedDay - 1);
      this.invalidate();
    } else if (matchesKey(data, "right") || data === "l") {
      this.selectedDay = Math.min(6, this.selectedDay + 1);
      this.invalidate();
    } else if (matchesKey(data, "up") || data === "k") {
      this.selectedHour = Math.max(START_HOUR, this.selectedHour - 1);
      this.invalidate();
    } else if (matchesKey(data, "down") || data === "j") {
      this.selectedHour = Math.min(END_HOUR - 1, this.selectedHour + 1);
      this.invalidate();
    }

    // Week navigation
    if (data === "n" || data === "N") {
      this.weekOffset++;
      this.invalidate();
    } else if (data === "p" || data === "P") {
      this.weekOffset--;
      this.invalidate();
    } else if (data === "t" || data === "T") {
      this.weekOffset = 0;
      this.invalidate();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const th = this.theme;
    const lines: string[] = [];
    const weekDays = getWeekDays(this.weekOffset);
    const today = new Date();
    const events = this.config.events ?? [];

    // Calculate column widths
    const timeColWidth = 6;
    const availableWidth = Math.max(width - timeColWidth - 2, 35);
    const dayColWidth = Math.floor(availableWidth / 7);

    // Title
    lines.push("");
    const title = th.bold(th.fg("accent", ` 📅 ${this.config.title || formatMonthYear(weekDays[0])} `));
    lines.push(truncateToWidth(title, width));
    lines.push("");

    // Day headers
    let headerLine = " ".repeat(timeColWidth);
    for (let i = 0; i < 7; i++) {
      const day = weekDays[i];
      const isToday = isSameDay(day, today);
      const isSelected = i === this.selectedDay;
      
      let dayStr = `${DAYS[day.getDay()]} ${formatDate(day)}`;
      dayStr = dayStr.slice(0, dayColWidth - 1).padEnd(dayColWidth - 1);
      
      if (isSelected) {
        dayStr = th.bg("selectedBg", th.fg("accent", dayStr));
      } else if (isToday) {
        dayStr = th.fg("accent", dayStr);
      } else {
        dayStr = th.fg("muted", dayStr);
      }
      headerLine += dayStr + " ";
    }
    lines.push(truncateToWidth(headerLine, width));
    
    // Separator
    lines.push(th.fg("dim", "─".repeat(Math.min(width, timeColWidth + dayColWidth * 7 + 7))));

    // Time slots
    for (let hour = START_HOUR; hour < END_HOUR; hour++) {
      const isSelectedHour = hour === this.selectedHour;
      
      // Hour label
      let hourStr = `${hour.toString().padStart(2)}:00 `;
      if (isSelectedHour) {
        hourStr = th.fg("accent", hourStr);
      } else {
        hourStr = th.fg("dim", hourStr);
      }

      let rowLine = hourStr;

      // Day columns
      for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
        const day = weekDays[dayIdx];
        const isSelected = dayIdx === this.selectedDay && isSelectedHour;

        // Find event at this slot
        const slotStart = new Date(day);
        slotStart.setHours(hour, 0, 0, 0);
        const slotEnd = new Date(day);
        slotEnd.setHours(hour + 1, 0, 0, 0);

        let cellContent = "";
        let hasEvent = false;

        for (const event of events) {
          const eventStart = parseTime(event.startTime);
          const eventEnd = parseTime(event.endTime);
          
          if (isSameDay(eventStart, day) && 
              eventStart.getHours() <= hour && 
              eventEnd.getHours() > hour) {
            hasEvent = true;
            const color = COLORS[event.color ?? "blue"] ?? COLORS.blue;
            const title = event.title.slice(0, dayColWidth - 2);
            cellContent = `${color} ${title.padEnd(dayColWidth - 2)}${RESET}`;
            break;
          }
        }

        if (!hasEvent) {
          if (isSelected) {
            cellContent = th.bg("selectedBg", th.fg("accent", "▶".padEnd(dayColWidth - 1)));
          } else {
            cellContent = th.fg("dim", "·".padEnd(dayColWidth - 1));
          }
        }

        rowLine += cellContent + " ";
      }

      lines.push(truncateToWidth(rowLine, width));
    }

    // Footer
    lines.push("");
    lines.push(th.fg("dim", "─".repeat(Math.min(width, timeColWidth + dayColWidth * 7 + 7))));
    const helpText = "←→↑↓:navigate  n/p:week  t:today  Enter:select  Esc:cancel";
    lines.push(truncateToWidth(th.fg("dim", " " + helpText), width));
    lines.push("");

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

// ============================================
// Document Canvas Component
// ============================================

class DocumentCanvas {
  private config: DocumentConfig;
  private theme: Theme;
  private scrollOffset: number = 0;
  private cursorLine: number = 0;
  private selectionStart: number | null = null;
  private selectionEnd: number | null = null;
  private onDone: (result: DocumentResult) => void;
  private lines: string[];
  private cachedWidth?: number;
  private cachedRender?: string[];

  constructor(config: DocumentConfig, theme: Theme, onDone: (result: DocumentResult) => void) {
    this.config = config;
    this.theme = theme;
    this.onDone = onDone;
    this.lines = config.content.split("\n");
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q" || data === "Q") {
      this.onDone({ 
        action: "closed",
        content: this.lines.join("\n"),
      });
      return;
    }

    // Navigation
    if (matchesKey(data, "up") || data === "k") {
      this.cursorLine = Math.max(0, this.cursorLine - 1);
      this.invalidate();
    } else if (matchesKey(data, "down") || data === "j") {
      this.cursorLine = Math.min(this.lines.length - 1, this.cursorLine + 1);
      this.invalidate();
    } else if (matchesKey(data, "ctrl+u")) {
      this.cursorLine = Math.max(0, this.cursorLine - 10);
      this.invalidate();
    } else if (matchesKey(data, "ctrl+d")) {
      this.cursorLine = Math.min(this.lines.length - 1, this.cursorLine + 10);
      this.invalidate();
    }

    // Selection
    if (data === "v" || data === "V") {
      if (this.selectionStart === null) {
        this.selectionStart = this.cursorLine;
        this.selectionEnd = this.cursorLine;
      } else {
        this.selectionEnd = this.cursorLine;
      }
      this.invalidate();
    } else if (matchesKey(data, "enter")) {
      if (this.selectionStart !== null && this.selectionEnd !== null) {
        const start = Math.min(this.selectionStart, this.selectionEnd);
        const end = Math.max(this.selectionStart, this.selectionEnd);
        const selectedLines = this.lines.slice(start, end + 1);
        this.onDone({
          action: "selected",
          selection: {
            text: selectedLines.join("\n"),
            startOffset: start,
            endOffset: end,
          },
        });
      }
    }
  }

  render(width: number): string[] {
    if (this.cachedRender && this.cachedWidth === width) {
      return this.cachedRender;
    }

    const th = this.theme;
    const output: string[] = [];
    const maxVisibleLines = 20;

    // Title
    output.push("");
    const title = th.bold(th.fg("accent", ` 📄 ${this.config.title || "Document"} `));
    output.push(truncateToWidth(title, width));
    output.push(th.fg("dim", "─".repeat(width - 2)));

    // Adjust scroll to keep cursor visible
    if (this.cursorLine < this.scrollOffset) {
      this.scrollOffset = this.cursorLine;
    } else if (this.cursorLine >= this.scrollOffset + maxVisibleLines) {
      this.scrollOffset = this.cursorLine - maxVisibleLines + 1;
    }

    // Content
    const startLine = this.scrollOffset;
    const endLine = Math.min(this.lines.length, startLine + maxVisibleLines);

    for (let i = startLine; i < endLine; i++) {
      const lineNum = (i + 1).toString().padStart(3) + " ";
      const isCursor = i === this.cursorLine;
      const isSelected = this.selectionStart !== null && 
        i >= Math.min(this.selectionStart, this.selectionEnd ?? this.selectionStart) &&
        i <= Math.max(this.selectionStart, this.selectionEnd ?? this.selectionStart);

      let lineContent = this.lines[i] || "";
      lineContent = lineContent.slice(0, width - 6);

      let formatted: string;
      if (isCursor) {
        formatted = th.fg("accent", lineNum) + th.bg("selectedBg", lineContent.padEnd(width - 5));
      } else if (isSelected) {
        formatted = th.fg("dim", lineNum) + th.bg("selectedBg", th.fg("muted", lineContent.padEnd(width - 5)));
      } else {
        formatted = th.fg("dim", lineNum) + lineContent;
      }

      output.push(truncateToWidth(formatted, width));
    }

    // Pad if needed
    for (let i = endLine - startLine; i < maxVisibleLines; i++) {
      output.push(th.fg("dim", "~"));
    }

    // Footer
    output.push(th.fg("dim", "─".repeat(width - 2)));
    const pos = `Line ${this.cursorLine + 1}/${this.lines.length}`;
    const selInfo = this.selectionStart !== null ? " [selecting]" : "";
    const helpText = "↑↓:navigate  v:select  Enter:confirm  Esc:close";
    output.push(truncateToWidth(th.fg("dim", ` ${pos}${selInfo}  ${helpText}`), width));
    output.push("");

    this.cachedWidth = width;
    this.cachedRender = output;
    return output;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedRender = undefined;
  }
}

// ============================================
// Flight Canvas Component
// ============================================

function formatPrice(cents: number, currency: string = "USD"): string {
  const dollars = cents / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(dollars);
}

function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins}m`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

function formatFlightTime(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

class FlightCanvas {
  private config: FlightConfig;
  private theme: Theme;
  private selectedIndex: number = 0;
  private onDone: (result: FlightResult) => void;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(config: FlightConfig, theme: Theme, onDone: (result: FlightResult) => void) {
    this.config = config;
    this.theme = theme;
    this.onDone = onDone;
  }

  handleInput(data: string): void {
    const flights = this.config.flights;

    if (matchesKey(data, "escape") || data === "q" || data === "Q") {
      this.onDone({ action: "cancelled" });
      return;
    }

    if (matchesKey(data, "enter")) {
      if (flights.length > 0) {
        this.onDone({
          action: "selected",
          flight: flights[this.selectedIndex],
        });
      }
      return;
    }

    // Navigation
    if (matchesKey(data, "up") || data === "k") {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.invalidate();
    } else if (matchesKey(data, "down") || data === "j") {
      this.selectedIndex = Math.min(flights.length - 1, this.selectedIndex + 1);
      this.invalidate();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const th = this.theme;
    const lines: string[] = [];
    const flights = this.config.flights;

    // Title
    lines.push("");
    const title = th.bold(th.fg("accent", ` ✈️  ${this.config.title || "Flight Search Results"} `));
    lines.push(truncateToWidth(title, width));
    lines.push(th.fg("dim", "─".repeat(width - 2)));
    lines.push("");

    if (flights.length === 0) {
      lines.push(th.fg("muted", "  No flights found"));
      lines.push("");
    } else {
      // Flight list
      for (let i = 0; i < flights.length; i++) {
        const flight = flights[i];
        const isSelected = i === this.selectedIndex;
        const prefix = isSelected ? th.fg("accent", "▶ ") : "  ";

        // Flight header line
        const airlineInfo = `${flight.airline} ${flight.flightNumber}`;
        const priceStr = th.fg("success", formatPrice(flight.price, flight.currency));
        
        let headerLine = `${prefix}${airlineInfo}`;
        const headerPadding = Math.max(1, width - visibleWidth(headerLine) - visibleWidth(priceStr) - 4);
        headerLine += " ".repeat(headerPadding) + priceStr;
        
        if (isSelected) {
          lines.push(th.bg("selectedBg", truncateToWidth(headerLine, width)));
        } else {
          lines.push(truncateToWidth(headerLine, width));
        }

        // Route line
        const depTime = formatFlightTime(flight.departureTime);
        const arrTime = formatFlightTime(flight.arrivalTime);
        const route = `${flight.origin.code} → ${flight.destination.code}`;
        const times = `${depTime} - ${arrTime}`;
        const duration = formatDuration(flight.duration);
        const stops = flight.stops === 0 ? th.fg("success", "Nonstop") : th.fg("warning", `${flight.stops} stop${flight.stops > 1 ? "s" : ""}`);

        let routeLine = `   ${route}  ${th.fg("muted", times)}  ${th.fg("dim", duration)}  ${stops}`;
        if (isSelected) {
          lines.push(th.bg("selectedBg", truncateToWidth(routeLine, width)));
        } else {
          lines.push(truncateToWidth(routeLine, width));
        }

        // Aircraft line (if available)
        if (flight.aircraft) {
          let aircraftLine = `   ${th.fg("dim", flight.aircraft)}`;
          if (isSelected) {
            lines.push(th.bg("selectedBg", truncateToWidth(aircraftLine, width)));
          } else {
            lines.push(truncateToWidth(aircraftLine, width));
          }
        }

        lines.push("");
      }
    }

    // Footer
    lines.push(th.fg("dim", "─".repeat(width - 2)));
    const helpText = "↑↓:navigate  Enter:select  Esc:cancel";
    lines.push(truncateToWidth(th.fg("dim", " " + helpText), width));
    lines.push("");

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

// ============================================
// Extension Entry Point
// ============================================

export default function (pi: ExtensionAPI) {
  
  // ==========================================
  // Tool: canvas_calendar
  // ==========================================
  pi.registerTool({
    name: "canvas_calendar",
    label: "Calendar Canvas",
    description: `Display an interactive calendar TUI. Users can navigate and select time slots.

Use this to:
- Show a week view calendar with events
- Let users pick a meeting time
- Display schedules

The calendar opens inline in pi's TUI. User navigates with arrow keys and presses Enter to select a time slot.`,
    parameters: Type.Object({
      title: Type.Optional(Type.String({ description: "Calendar title" })),
      events: Type.Optional(Type.Array(Type.Object({
        id: Type.String(),
        title: Type.String(),
        startTime: Type.String({ description: "ISO datetime" }),
        endTime: Type.String({ description: "ISO datetime" }),
        color: Type.Optional(StringEnum(["blue", "green", "yellow", "red", "magenta", "cyan"] as const)),
      }), { description: "Calendar events to display" })),
      weekOffset: Type.Optional(Type.Number({ description: "Week offset (0=current, -1=last, 1=next)" })),
    }),

    async execute(toolCallId, params, onUpdate, ctx, signal) {
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: "Calendar canvas requires interactive mode" }],
          isError: true,
        };
      }

      const config: CalendarConfig = {
        title: params.title,
        events: params.events,
        weekOffset: params.weekOffset,
      };

      const result = await ctx.ui.custom<CalendarResult>((tui, theme, done) => {
        const canvas = new CalendarCanvas(config, theme, done);
        return {
          render: (w) => canvas.render(w),
          invalidate: () => canvas.invalidate(),
          handleInput: (data) => {
            canvas.handleInput(data);
            tui.requestRender();
          },
        };
      });

      if (result.action === "cancelled") {
        return {
          content: [{ type: "text", text: "Calendar cancelled by user" }],
          details: { action: "cancelled" },
        };
      }

      return {
        content: [{
          type: "text",
          text: `Selected time slot: ${result.slot?.date} at ${result.slot?.hour}:${String(result.slot?.minute ?? 0).padStart(2, "0")}`,
        }],
        details: {
          action: "selected",
          slot: result.slot,
        },
      };
    },
  });

  // ==========================================
  // Tool: canvas_document
  // ==========================================
  pi.registerTool({
    name: "canvas_document",
    label: "Document Canvas",
    description: `Display a document in an interactive TUI viewer. Users can navigate and select text.

Use this to:
- Show text/markdown content for review
- Let users select portions of text
- Display logs, code, or any text content

The document opens inline in pi's TUI. User navigates with arrow keys, uses 'v' to start selection, and Enter to confirm.`,
    parameters: Type.Object({
      content: Type.String({ description: "Document content to display" }),
      title: Type.Optional(Type.String({ description: "Document title" })),
    }),

    async execute(toolCallId, params, onUpdate, ctx, signal) {
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: "Document canvas requires interactive mode" }],
          isError: true,
        };
      }

      const config: DocumentConfig = {
        content: params.content,
        title: params.title,
      };

      const result = await ctx.ui.custom<DocumentResult>((tui, theme, done) => {
        const canvas = new DocumentCanvas(config, theme, done);
        return {
          render: (w) => canvas.render(w),
          invalidate: () => canvas.invalidate(),
          handleInput: (data) => {
            canvas.handleInput(data);
            tui.requestRender();
          },
        };
      });

      if (result.action === "closed") {
        return {
          content: [{ type: "text", text: "Document closed" }],
          details: { action: "closed" },
        };
      }

      return {
        content: [{
          type: "text",
          text: `Selected text (lines ${result.selection?.startOffset}-${result.selection?.endOffset}):\n${result.selection?.text}`,
        }],
        details: {
          action: "selected",
          selection: result.selection,
        },
      };
    },
  });

  // ==========================================
  // Tool: canvas_flights
  // ==========================================
  pi.registerTool({
    name: "canvas_flights",
    label: "Flight Canvas",
    description: `Display flight search results in an interactive TUI. Users can browse and select flights.

Use this to:
- Show flight options for a route
- Let users compare and select flights
- Display pricing, times, and stops

The flight list opens inline in pi's TUI. User navigates with arrow keys and presses Enter to select a flight.`,
    parameters: Type.Object({
      title: Type.Optional(Type.String({ description: "Title for the flight search" })),
      flights: Type.Array(Type.Object({
        id: Type.String(),
        airline: Type.String({ description: "Airline name, e.g., 'United Airlines'" }),
        flightNumber: Type.String({ description: "Flight number, e.g., 'UA 123'" }),
        origin: Type.Object({
          code: Type.String({ description: "Airport code, e.g., 'SFO'" }),
          name: Type.String({ description: "Airport name" }),
          city: Type.String({ description: "City name" }),
        }),
        destination: Type.Object({
          code: Type.String({ description: "Airport code, e.g., 'JFK'" }),
          name: Type.String({ description: "Airport name" }),
          city: Type.String({ description: "City name" }),
        }),
        departureTime: Type.String({ description: "ISO datetime" }),
        arrivalTime: Type.String({ description: "ISO datetime" }),
        duration: Type.Number({ description: "Duration in minutes" }),
        price: Type.Number({ description: "Price in cents" }),
        currency: Type.String({ description: "Currency code, e.g., 'USD'" }),
        stops: Type.Number({ description: "Number of stops (0 = nonstop)" }),
        aircraft: Type.Optional(Type.String({ description: "Aircraft type" })),
      }), { description: "List of flights to display" }),
    }),

    async execute(toolCallId, params, onUpdate, ctx, signal) {
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: "Flight canvas requires interactive mode" }],
          isError: true,
        };
      }

      const config: FlightConfig = {
        title: params.title,
        flights: params.flights,
      };

      const result = await ctx.ui.custom<FlightResult>((tui, theme, done) => {
        const canvas = new FlightCanvas(config, theme, done);
        return {
          render: (w) => canvas.render(w),
          invalidate: () => canvas.invalidate(),
          handleInput: (data) => {
            canvas.handleInput(data);
            tui.requestRender();
          },
        };
      });

      if (result.action === "cancelled") {
        return {
          content: [{ type: "text", text: "Flight selection cancelled" }],
          details: { action: "cancelled" },
        };
      }

      const flight = result.flight!;
      return {
        content: [{
          type: "text",
          text: `Selected flight: ${flight.airline} ${flight.flightNumber}
Route: ${flight.origin.code} → ${flight.destination.code}
Departure: ${flight.departureTime}
Arrival: ${flight.arrivalTime}
Price: ${formatPrice(flight.price, flight.currency)}
Stops: ${flight.stops === 0 ? "Nonstop" : flight.stops}`,
        }],
        details: {
          action: "selected",
          flight: result.flight,
        },
      };
    },
  });

  // ==========================================
  // Command: /calendar
  // ==========================================
  pi.registerCommand("calendar", {
    description: "Open an interactive calendar view",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Calendar requires interactive mode", "error");
        return;
      }

      const result = await ctx.ui.custom<CalendarResult>((tui, theme, done) => {
        const canvas = new CalendarCanvas({ title: "Calendar" }, theme, done);
        return {
          render: (w) => canvas.render(w),
          invalidate: () => canvas.invalidate(),
          handleInput: (data) => {
            canvas.handleInput(data);
            tui.requestRender();
          },
        };
      });

      if (result.action === "selected" && result.slot) {
        ctx.ui.notify(`Selected: ${result.slot.date} at ${result.slot.hour}:00`, "info");
      }
    },
  });

  // ==========================================
  // Startup
  // ==========================================
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus("pi-canvas", "📅");
      setTimeout(() => ctx.ui.setStatus("pi-canvas", undefined), 2000);
    }
  });
}
