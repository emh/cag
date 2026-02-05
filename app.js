import { h, render } from "preact";
import { signal, effect } from "@preact/signals";
import {
  Brush,
  Circle,
  Eraser,
  Minus,
  PaintBucket,
  PencilRuler,
  RotateCcw,
  RotateCw,
  Ruler,
  RulerDimensionLine,
  Spline,
  Stamp,
} from "https://cdn.jsdelivr.net/npm/lucide-preact@0.563.0/+esm";

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const APP_TITLE = "Computer Aided Geometry";
const DEFAULT_DRAWING_FILE_NAME = "cag-drawing.json";
document.title = APP_TITLE;

function shouldHideToolPaletteByDefault() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(max-width: 768px), (pointer: coarse)").matches;
}

const tool = signal("straightedge");
const palette = signal([
  "#e63946",
  "#f4a261",
  "#f6c945",
  "#2a9d8f",
  "#3b82f6",
  "#8b5cf6",
  "#ffffff",
  "#e5e7eb",
  "#cbd5e1",
  "#94a3b8",
  "#475569",
  "#000000",
]);
const fillColor = signal(palette.value[0]);
const fillAlpha = signal(0.65);
const status = signal("");
const measureDistance = signal(null);
const zoomValue = signal(1);
const inkThickness = signal(2);
const stampShape = signal("square");
const stampSize = signal(60);
const showGuides = signal(true);
const gridSettings = signal({
  show: true,
  pattern: "square",
  style: "lines",
  size: 40,
  snap: false,
});
const openMenu = signal(null);
const showInfoDialog = signal(true);
const showSaveDialog = signal(false);
const saveDialogFileName = signal(DEFAULT_DRAWING_FILE_NAME);
const showToolPalette = signal(!shouldHideToolPaletteByDefault());
const showFillPalette = signal(false);
const showStampPalette = signal(false);
const toolPalettePosition = signal({ x: 12, y: 58 });
const fillPalettePosition = signal({ x: 324, y: 58 });
const stampPalettePosition = signal({ x: 632, y: 58 });
const toolHelpTick = signal(0);
const menuHoverHelp = signal({
  file: "",
  edit: "",
  tool: "",
  settings: "",
  grid: "",
  view: "",
});

const view = {
  scale: 1,
  panX: 0,
  panY: 0,
};

const state = {
  primitives: [],
  ink: [],
  fills: [],
  nextPrimId: 1,
  nextInkId: 1,
  nextFillId: 1,
};

let intersections = {
  list: [],
  byPrim: new Map(),
  byId: new Map(),
};

let toolState = {
  step: 0,
};

let hoverSnap = null;
let pointerWorld = { x: 0, y: 0 };
let spaceDown = false;
let isPanning = false;
let panStart = { x: 0, y: 0 };
let pointerStart = { x: 0, y: 0 };
let rerasterizeTimer = null;
let panDirty = false;
let paletteEditIndex = null;
let draggingPalette = null;
let currentDrawingFileName = DEFAULT_DRAWING_FILE_NAME;
const activeTouchPoints = new Map();
let touchTapCandidate = null;
let touchGesture = null;
let touchDrawGesture = null;
let touchMenuSession = null;

const history = {
  past: [],
  future: [],
};

const SNAP_PX = 10;
const HIT_PX = 8;
const ARC_SPAN = Math.PI / 7;
const EPS = 1e-6;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 40;
const MAX_FILL_PIXELS = 4_000_000;
const MAX_FILL_DIM = 8192;
const GRID_COLOR = "rgba(15, 23, 42, 0.08)";
const GRID_DOT_COLOR = "rgba(15, 23, 42, 0.12)";
const PALETTE_GUTTER = 8;
const TOUCH_TAP_SLOP_PX = 10;

const toolDefs = [
  { id: "straightedge", label: "Straightedge", key: "1", Icon: Ruler },
  { id: "segment", label: "Line Segment", key: "2", Icon: Minus },
  { id: "compass", label: "Circle", key: "3", Icon: Circle },
  { id: "arc", label: "Arc", key: "4", Icon: Spline },
  { id: "ink", label: "Ink", key: "5", Icon: Brush },
  { id: "fill", label: "Fill", key: "6", Icon: PaintBucket },
  { id: "stamp", label: "Stamp", key: "7", Icon: Stamp },
  { id: "copy", label: "Copy Measure", key: "8", Icon: RulerDimensionLine },
  { id: "paste", label: "Paste Measure", key: "9", Icon: PencilRuler },
  { id: "erase", label: "Delete", key: "D", Icon: Eraser },
];

const mobileFooterToolIds = ["straightedge", "segment", "compass", "arc", "ink", "fill"];
const toolDefsById = new Map(toolDefs.map((def) => [def.id, def]));

const TOOL_MENU_HELP = {
  straightedge: "Draws an infinite line through two selected points.",
  segment: "Draws a finite line segment between two selected points.",
  compass: "Draws a circle from a selected center and radius point.",
  arc: "Draws an arc from center, start, and end points.",
  ink: "Inks a visible span on a line, segment, circle, or arc.",
  fill: "Fills an enclosed region bounded by inked edges.",
  stamp: "Stamps the selected shape at the clicked location.",
  copy: "Copies a distance from a segment, circle radius, or two points.",
  paste: "Places the copied distance as a measurement arc from a center point.",
  erase: "Deletes a primitive, ink segment, or fill region.",
};

function ToolIcon({ Icon, size = 18, className = "tool-icon" }) {
  return h(Icon, {
    size,
    strokeWidth: 2,
    className,
    "aria-hidden": "true",
    focusable: "false",
  });
}

function bumpToolHelpTick() {
  toolHelpTick.value += 1;
}

const DEFAULT_MENU_HELP = {
  file: "Manage drawings: save or load JSON, export PNG, share, or open info.",
  edit: "Undo, redo, or clear the drawing.",
  tool: "Choose the active drawing tool.",
  settings: "Adjust fill colors, stamp setup, ink thickness, and fill alpha.",
  grid: "Configure grid visibility, snap, size, pattern, and style.",
  view: "Toggle palettes and guides, then control zoom.",
};

function setMenuHoverHelp(menuId, text) {
  if (!menuId) return;
  const prev = menuHoverHelp.value;
  if (prev[menuId] === text) return;
  menuHoverHelp.value = { ...prev, [menuId]: text };
}

function clearMenuHoverHelp(menuId) {
  if (!menuId) return;
  const prev = menuHoverHelp.value;
  if (!prev[menuId]) return;
  menuHoverHelp.value = { ...prev, [menuId]: "" };
}

function isTouchPointerEvent(event) {
  return event?.pointerType === "touch";
}

function clearTouchMenuSession({ closeMenu = false } = {}) {
  if (!touchMenuSession) return;
  touchMenuSession.highlightEl?.classList.remove("touch-highlight");
  touchMenuSession.submenuHost?.classList.remove("touch-submenu-open");
  const activeMenuId = touchMenuSession.menuId;
  touchMenuSession = null;
  if (!closeMenu) return;
  if (openMenu.value) {
    clearMenuHoverHelp(openMenu.value);
  } else if (activeMenuId) {
    clearMenuHoverHelp(activeMenuId);
  }
  openMenu.value = null;
}

function setTouchMenuHighlight(nextEl) {
  if (!touchMenuSession) return;
  if (touchMenuSession.highlightEl === nextEl) return;
  if (touchMenuSession.highlightEl) {
    touchMenuSession.highlightEl.classList.remove("touch-highlight");
  }
  touchMenuSession.highlightEl = nextEl || null;
  if (touchMenuSession.highlightEl) {
    touchMenuSession.highlightEl.classList.add("touch-highlight");
  }
}

function setTouchMenuSubmenuHost(nextHost) {
  if (!touchMenuSession) return;
  if (touchMenuSession.submenuHost === nextHost) return;
  if (touchMenuSession.submenuHost) {
    touchMenuSession.submenuHost.classList.remove("touch-submenu-open");
  }
  touchMenuSession.submenuHost = nextHost || null;
  if (touchMenuSession.submenuHost) {
    touchMenuSession.submenuHost.classList.add("touch-submenu-open");
  }
}

function beginTouchMenuSession(menuId, pointerId) {
  clearTouchMenuSession();
  if (openMenu.value && openMenu.value !== menuId) {
    clearMenuHoverHelp(openMenu.value);
  }
  openMenu.value = menuId;
  touchMenuSession = {
    menuId,
    pointerId,
    highlightEl: null,
    submenuHost: null,
  };
}

function getTouchMenuGroupElement(menuId) {
  return document.querySelector(`.menu-group[data-menu-id="${menuId}"]`);
}

function resolveTouchMenuTargets(menuId, clientX, clientY) {
  const group = getTouchMenuGroupElement(menuId);
  if (!group) return { highlightEl: null, submenuHost: null };
  const hit = document.elementFromPoint(clientX, clientY);
  if (!hit || !group.contains(hit)) return { highlightEl: null, submenuHost: null };

  const submenuAction = hit.closest(".menu-submenu .menu-action");
  if (submenuAction && group.contains(submenuAction)) {
    return {
      highlightEl: submenuAction,
      submenuHost: submenuAction.closest(".menu-item.has-submenu"),
    };
  }

  const submenuHost = hit.closest(".menu-item.has-submenu");
  if (submenuHost && group.contains(submenuHost)) {
    return {
      highlightEl: null,
      submenuHost,
    };
  }

  const selectable = hit.closest(".menu-action, .menu-toggle");
  if (selectable && group.contains(selectable)) {
    return {
      highlightEl: selectable,
      submenuHost: null,
    };
  }

  return { highlightEl: null, submenuHost: null };
}

function updateTouchMenuSelection(clientX, clientY) {
  if (!touchMenuSession) return;
  const { highlightEl, submenuHost } = resolveTouchMenuTargets(touchMenuSession.menuId, clientX, clientY);
  setTouchMenuSubmenuHost(submenuHost);
  setTouchMenuHighlight(highlightEl);
}

function handleTouchMenuPointerMove(event) {
  if (!touchMenuSession || !isTouchPointerEvent(event) || event.pointerId !== touchMenuSession.pointerId) {
    return;
  }
  event.preventDefault();
  updateTouchMenuSelection(event.clientX, event.clientY);
}

function handleTouchMenuPointerEnd(event) {
  if (!touchMenuSession || !isTouchPointerEvent(event) || event.pointerId !== touchMenuSession.pointerId) {
    return;
  }
  event.preventDefault();
  updateTouchMenuSelection(event.clientX, event.clientY);
  const canceled = event.type === "pointercancel";
  const selected = !canceled ? touchMenuSession.highlightEl : null;
  if (selected) {
    selected.click();
  }
  clearTouchMenuSession({ closeMenu: true });
}

function withMenuHelp(menuId, text, props = {}) {
  const nextProps = { ...props };
  const onMouseEnter = nextProps.onMouseEnter;
  const onMouseLeave = nextProps.onMouseLeave;
  const onFocus = nextProps.onFocus;
  const onBlur = nextProps.onBlur;
  nextProps.onMouseEnter = (event) => {
    setMenuHoverHelp(menuId, text);
    onMouseEnter?.(event);
  };
  nextProps.onMouseLeave = (event) => {
    onMouseLeave?.(event);
  };
  nextProps.onFocus = (event) => {
    setMenuHoverHelp(menuId, text);
    onFocus?.(event);
  };
  nextProps.onBlur = (event) => {
    onBlur?.(event);
  };
  return nextProps;
}

function getMenuHelpText(menuId) {
  return menuHoverHelp.value[menuId] || DEFAULT_MENU_HELP[menuId] || "";
}

function renderMenuHelp(menuId) {
  return h("p", { class: "menu-help-block", role: "note" }, getMenuHelpText(menuId));
}

function getPalettePositionSignal(paletteId) {
  if (paletteId === "tools") return toolPalettePosition;
  if (paletteId === "fill-colors") return fillPalettePosition;
  if (paletteId === "stamp") return stampPalettePosition;
  return null;
}

function clampPalettePosition(position, size = { width: 0, height: 0 }) {
  const maxX = Math.max(PALETTE_GUTTER, window.innerWidth - size.width - PALETTE_GUTTER);
  const maxY = Math.max(PALETTE_GUTTER, window.innerHeight - size.height - PALETTE_GUTTER);
  return {
    x: Math.max(PALETTE_GUTTER, Math.min(position.x, maxX)),
    y: Math.max(PALETTE_GUTTER, Math.min(position.y, maxY)),
  };
}

function startPaletteDrag(event, paletteId) {
  if (event.button !== undefined && event.button !== 0) return;
  const positionSignal = getPalettePositionSignal(paletteId);
  if (!positionSignal) return;
  const paletteWindow = event.currentTarget?.closest?.(".palette-window");
  draggingPalette = {
    id: paletteId,
    offsetX: event.clientX - positionSignal.value.x,
    offsetY: event.clientY - positionSignal.value.y,
    width: paletteWindow?.offsetWidth || 0,
    height: paletteWindow?.offsetHeight || 0,
  };
  event.preventDefault();
}

function handlePaletteDrag(event) {
  if (!draggingPalette) return;
  const positionSignal = getPalettePositionSignal(draggingPalette.id);
  if (!positionSignal) return;
  positionSignal.value = clampPalettePosition({
    x: event.clientX - draggingPalette.offsetX,
    y: event.clientY - draggingPalette.offsetY,
  }, {
    width: draggingPalette.width,
    height: draggingPalette.height,
  });
}

function stopPaletteDrag() {
  draggingPalette = null;
}

function StampIcon({ shape }) {
  const svgProps = {
    class: "stamp-icon",
    viewBox: "0 0 100 100",
    "aria-hidden": "true",
    focusable: "false",
  };

  if (shape === "square") {
    return h("svg", svgProps, h("rect", { x: 22, y: 22, width: 56, height: 56, rx: 8, ry: 8 }));
  }
  if (shape === "circle") {
    return h("svg", svgProps, h("circle", { cx: 50, cy: 50, r: 30 }));
  }
  if (shape === "hex") {
    return h(
      "svg",
      svgProps,
      h("polygon", {
        points: "50 18 80 34 80 66 50 82 20 66 20 34",
      })
    );
  }
  if (shape === "triangle") {
    return h("svg", svgProps, h("polygon", { points: "50 18 82 78 18 78" }));
  }
  return null;
}

function Toolbar() {
  const paletteEditInputId = "palette-edit-picker";
  const stampOptions = [
    { id: "square", label: "Square" },
    { id: "circle", label: "Circle" },
    { id: "hex", label: "Hexagon" },
    { id: "triangle", label: "Triangle" },
  ];

  const setFillColor = (color) => {
    fillColor.value = color;
    scheduleRender();
  };

  const addPaletteColor = (color) => {
    if (!color) return;
    const normalized = color.toLowerCase();
    if (!palette.value.includes(normalized)) {
      palette.value = [...palette.value, normalized];
    }
    setFillColor(normalized);
  };

  const updatePaletteColor = (color, index) => {
    if (!color || index === null || index === undefined) return;
    const normalized = color.toLowerCase();
    const existingIndex = palette.value.indexOf(normalized);
    const previous = palette.value[index];
    if (existingIndex !== -1 && existingIndex !== index) {
      palette.value = palette.value.filter((_, idx) => idx !== index);
      if (fillColor.value === previous) {
        fillColor.value = normalized;
      }
      return;
    }
    palette.value = palette.value.map((item, idx) => (idx === index ? normalized : item));
    if (fillColor.value === previous) {
      fillColor.value = normalized;
      scheduleRender();
    }
  };

  const removePaletteColor = (color) => {
    palette.value = palette.value.filter((item) => item !== color);
    if (fillColor.value === color) {
      const next = palette.value[0] || "#000000";
      fillColor.value = next;
      scheduleRender();
    }
  };

  const updateGrid = (patch) => {
    gridSettings.value = { ...gridSettings.value, ...patch };
    scheduleRender();
  };

  const setStamp = (shape) => {
    stampShape.value = shape;
    scheduleRender();
  };

  const toggleGuides = (value) => {
    showGuides.value = value;
    scheduleRender();
  };

  const toggleToolPalette = (value) => {
    showToolPalette.value = value;
  };

  const toggleFillPalette = (value) => {
    showFillPalette.value = value;
  };

  const toggleStampPalette = (value) => {
    showStampPalette.value = value;
  };

  const openInfoDialog = () => {
    showInfoDialog.value = true;
  };

  const closeInfoDialog = () => {
    showInfoDialog.value = false;
  };

  const closeSaveDialog = () => {
    showSaveDialog.value = false;
  };

  const handleSaveDialogSubmit = () => {
    confirmSaveDialog();
  };

  const openHoverMenu = (menuId) => {
    if (openMenu.value && openMenu.value !== menuId) {
      clearMenuHoverHelp(openMenu.value);
    }
    openMenu.value = menuId;
  };

  const closeHoverMenu = (menuId) => {
    if (openMenu.value === menuId) {
      openMenu.value = null;
    }
    clearMenuHoverHelp(menuId);
  };

  const runMenuAction = (fn) => {
    fn();
    if (openMenu.value) {
      clearMenuHoverHelp(openMenu.value);
    }
    openMenu.value = null;
  };

  const startTouchMenuDrag = (event, menuId) => {
    if (!isTouchPointerEvent(event)) return;
    event.preventDefault();
    event.stopPropagation();
    beginTouchMenuSession(menuId, event.pointerId);
  };

  const getToolHelpText = () => {
    toolHelpTick.value;
    if (tool.value === "straightedge") {
      return toolState.anchor
        ? "Click to select another point on the line."
        : "Click to select a point on the line.";
    }
    if (tool.value === "segment") {
      return toolState.anchor
        ? "Click to select the end point of the line segment."
        : "Click to select the start point of the line segment.";
    }
    if (tool.value === "compass") {
      return toolState.center
        ? "Click to select a point on the circle's circumference."
        : "Click to select the circle's center point.";
    }
    if (tool.value === "arc") {
      if (!toolState.center) return "Click to select the arc's center point.";
      if (!toolState.start) return "Click to select the arc's start point on the circumference.";
      return "Click to select the arc's end point on the circumference.";
    }
    if (tool.value === "ink") {
      return "Click a line, segment, circle, or arc to ink that span.";
    }
    if (tool.value === "fill") {
      return "Click inside an enclosed ink region to fill it.";
    }
    if (tool.value === "stamp") {
      return "Click to place the current stamp at that point.";
    }
    if (tool.value === "copy") {
      return toolState.p0
        ? "Click to select a second point and copy that distance."
        : "Click a segment/circle to copy its measure, or click to select the first point.";
    }
    if (tool.value === "paste") {
      if (!measureDistance.value) return "Copy a measure first using Copy Measure.";
      return toolState.center
        ? "Click to set the direction for the copied measure."
        : "Click to select the center point for the copied measure.";
    }
    if (tool.value === "erase") {
      return "Click geometry, ink, or fill to delete it.";
    }
    return "";
  };

  const positionEditPicker = (event, input) => {
    if (!input) return;
    const rect = event.currentTarget.getBoundingClientRect();
    input.style.left = `${rect.right + 8}px`;
    input.style.top = `${rect.top}px`;
    input.style.width = `${Math.max(28, rect.width)}px`;
    input.style.height = `${rect.height}px`;
  };

  const resetEditPicker = (input) => {
    if (!input) return;
    input.style.left = "-9999px";
    input.style.top = "-9999px";
    input.style.width = "1px";
    input.style.height = "1px";
    input.style.pointerEvents = "none";
  };

  const setStampSizeValue = (value) => {
    stampSize.value = Number(value);
    scheduleRender();
  };

  const setInkThicknessValue = (value) => {
    inkThickness.value = Number(value);
    scheduleRender();
  };

  const setFillAlphaValue = (value) => {
    fillAlpha.value = Number(value);
  };

  const renderFillColorGrid = ({ editable = false, editInputId = "" } = {}) =>
    h(
      "div",
      { class: "palette" },
      palette.value.map((color, index) => {
        const buttonProps = {
          type: "button",
          class: `swatch ${fillColor.value === color ? "active" : ""}`,
          style: { backgroundColor: color },
          onClick: () => setFillColor(color),
        };
        if (editable && editInputId) {
          buttonProps.onDblClick = (event) => {
            const input = document.getElementById(editInputId);
            if (!input) return;
            paletteEditIndex = index;
            input.value = color;
            positionEditPicker(event, input);
            if (input.showPicker) {
              input.showPicker();
            } else {
              input.click();
            }
          };
        }
        return h(
          "button",
          buttonProps,
          h(
            "span",
            {
              class: "swatch-remove",
              onClick: (event) => {
                event.stopPropagation();
                removePaletteColor(color);
              },
            },
            "×"
          )
        );
      }),
      h(
        "div",
        { class: "swatch add" },
        h("span", { class: "swatch-add-label" }, "+"),
        h("input", {
          class: "palette-input",
          type: "color",
          onChange: (event) => {
            addPaletteColor(event.target.value);
            event.target.blur();
          },
        })
      ),
      editable && editInputId
        ? h("input", {
            id: editInputId,
            class: "palette-input edit",
            type: "color",
            onChange: (event) => {
              updatePaletteColor(event.target.value, paletteEditIndex);
              paletteEditIndex = null;
              resetEditPicker(event.target);
              event.target.blur();
            },
            onBlur: (event) => {
              paletteEditIndex = null;
              resetEditPicker(event.target);
            },
          })
        : null
    );

  const renderStampControls = () =>
    h(
      "div",
      { class: "stamp-controls" },
      h("span", { class: "stamp-label" }, "Stamp"),
      h(
        "div",
        { class: "stamp-grid" },
        stampOptions.map((option) =>
          h(
            "button",
            {
              type: "button",
              class: `stamp-btn swatch ${stampShape.value === option.id ? "active" : ""}`,
              onClick: () => setStamp(option.id),
              "aria-label": option.label,
              title: option.label,
            },
            h(StampIcon, { shape: option.id })
          )
        )
      ),
      h(
        "div",
        { class: "stamp-size" },
        h("span", { class: "stamp-size-label" }, "Size"),
        h("input", {
          type: "range",
          min: 10,
          max: 200,
          step: 5,
          value: stampSize.value,
          onInput: (event) => setStampSizeValue(event.target.value),
        }),
        h("span", { class: "stamp-size-value" }, `${stampSize.value}px`)
      )
    );

  const renderInkThicknessControl = () =>
    h(
      "div",
      { class: "thickness-controls" },
      h("span", { class: "thickness-label" }, "Ink"),
      h("input", {
        type: "range",
        min: 1,
        max: 8,
        step: 0.5,
        value: inkThickness.value,
        onInput: (event) => setInkThicknessValue(event.target.value),
      }),
      h("span", { class: "thickness-value" }, `${inkThickness.value.toFixed(1)}px`)
    );

  const renderFillAlphaControl = () =>
    h(
      "div",
      { class: "alpha-controls" },
      h("span", { class: "alpha-label" }, "Fill Alpha"),
      h("input", {
        type: "range",
        min: 0,
        max: 1,
        step: 0.05,
        value: fillAlpha.value,
        onInput: (event) => setFillAlphaValue(event.target.value),
      }),
      h("span", { class: "alpha-value" }, `${Math.round(fillAlpha.value * 100)}%`)
    );

  const renderPaletteWindow = ({ id, title, className, position, onClose, children }) =>
    h(
      "div",
      {
        class: `palette-window ${className}`.trim(),
        style: {
          left: `${position.x}px`,
          top: `${position.y}px`,
        },
      },
      h(
        "div",
        {
          class: "palette-window-header",
          onPointerDown: (event) => startPaletteDrag(event, id),
        },
        h("span", { class: "palette-window-title" }, title),
        h(
          "button",
          {
            type: "button",
            class: "palette-window-close",
            onPointerDown: (event) => event.stopPropagation(),
            onClick: onClose,
            "aria-label": `Close ${title}`,
          },
          "×"
        )
      ),
      h("div", { class: "palette-window-body" }, children)
    );

  return h(
    "div",
    { class: "ui-shell" },
    h(
      "div",
      { class: "menu-bar" },
      h(
        "div",
        {
          class: `menu-group ${openMenu.value === "file" ? "open" : ""}`,
          "data-menu-id": "file",
          onMouseEnter: () => openHoverMenu("file"),
          onMouseLeave: () => closeHoverMenu("file"),
        },
        h("div", { class: "menu-trigger", onPointerDown: (event) => startTouchMenuDrag(event, "file") }, "File"),
        h(
          "div",
          { class: "menu-panel" },
          h(
            "button",
            {
              type: "button",
              class: "menu-action",
              ...withMenuHelp("file", "Choose a filename and download the current drawing as JSON."),
              onClick: () => runMenuAction(() => saveDrawingJson()),
            },
            h("span", null, "Save JSON"),
            h("span", { class: "menu-shortcut" }, "⌘/Ctrl+S")
          ),
          h(
            "button",
            {
              type: "button",
              class: "menu-action",
              ...withMenuHelp("file", "Load a local JSON drawing file and render it on the canvas."),
              onClick: () => runMenuAction(() => loadDrawingJson()),
            },
            h("span", null, "Load JSON"),
            h("span", { class: "menu-shortcut" }, "⌘/Ctrl+O")
          ),
          h("div", { class: "menu-divider" }),
          h(
            "button",
            {
              type: "button",
              class: "menu-action",
              ...withMenuHelp("file", "Export the drawing as a PNG image."),
              onClick: () => runMenuAction(() => downloadPng()),
            },
            h("span", null, "Download PNG")
          ),
          h(
            "button",
            {
              type: "button",
              class: "menu-action",
              ...withMenuHelp("file", "Copy a shareable URL that includes the current drawing."),
              onClick: () => runMenuAction(() => copyShareUrl()),
            },
            h("span", null, "Share")
          ),
          h("div", { class: "menu-divider" }),
          h(
            "button",
            {
              type: "button",
              class: "menu-action",
              ...withMenuHelp("file", "Open the quick help and shortcut reference dialog."),
              onClick: () => runMenuAction(() => openInfoDialog()),
            },
            h("span", null, "Info")
          ),
          h("div", { class: "menu-divider" }),
          renderMenuHelp("file")
        )
      ),
      h(
        "div",
        {
          class: `menu-group ${openMenu.value === "edit" ? "open" : ""}`,
          "data-menu-id": "edit",
          onMouseEnter: () => openHoverMenu("edit"),
          onMouseLeave: () => closeHoverMenu("edit"),
        },
        h("div", { class: "menu-trigger", onPointerDown: (event) => startTouchMenuDrag(event, "edit") }, "Edit"),
        h(
          "div",
          { class: "menu-panel" },
          h(
            "button",
            {
              type: "button",
              class: "menu-action",
              ...withMenuHelp("edit", "Undo the most recent change."),
              onClick: () => runMenuAction(() => undo()),
            },
            h("span", null, "Undo"),
            h("span", { class: "menu-shortcut" }, "Z")
          ),
          h(
            "button",
            {
              type: "button",
              class: "menu-action",
              ...withMenuHelp("edit", "Redo the next change in history."),
              onClick: () => runMenuAction(() => redo()),
            },
            h("span", null, "Redo"),
            h("span", { class: "menu-shortcut" }, "Y")
          ),
          h(
            "button",
            {
              type: "button",
              class: "menu-action danger",
              ...withMenuHelp("edit", "Clear all primitives, ink, and fills from the canvas."),
              onClick: () => runMenuAction(() => clearAll()),
            },
            h("span", null, "Clear"),
            h("span", { class: "menu-shortcut" }, "X")
          ),
          h("div", { class: "menu-divider" }),
          renderMenuHelp("edit")
        )
      ),
      h(
        "div",
        {
          class: `menu-group ${openMenu.value === "tool" ? "open" : ""}`,
          "data-menu-id": "tool",
          onMouseEnter: () => openHoverMenu("tool"),
          onMouseLeave: () => closeHoverMenu("tool"),
        },
        h("div", { class: "menu-trigger", onPointerDown: (event) => startTouchMenuDrag(event, "tool") }, "Tool"),
        h(
          "div",
          { class: "menu-panel menu-panel-tools" },
          toolDefs.map((def) =>
            h(
              "button",
              {
                type: "button",
                class: `menu-action ${tool.value === def.id ? "selected" : ""}`,
                ...withMenuHelp("tool", TOOL_MENU_HELP[def.id] || `Switch to ${def.label}.`),
                onClick: () => runMenuAction(() => setTool(def.id)),
                title: def.label,
              },
              h(
                "span",
                { class: "menu-action-label" },
                h(ToolIcon, { Icon: def.Icon, size: 15 }),
                h("span", null, def.label)
              ),
              h("span", { class: "menu-shortcut" }, def.key)
            )
          ),
          h("div", { class: "menu-divider" }),
          renderMenuHelp("tool")
        )
      ),
      h(
        "div",
        {
          class: `menu-group ${openMenu.value === "settings" ? "open" : ""}`,
          "data-menu-id": "settings",
          onMouseEnter: () => openHoverMenu("settings"),
          onMouseLeave: () => closeHoverMenu("settings"),
        },
        h(
          "div",
          { class: "menu-trigger", onPointerDown: (event) => startTouchMenuDrag(event, "settings") },
          "Settings"
        ),
        h(
          "div",
          { class: "menu-panel menu-panel-settings" },
          h(
            "div",
            { class: "menu-section-label", ...withMenuHelp("settings", "Choose colors used by the Fill tool.") },
            "Fill Colors"
          ),
          h(
            "div",
            withMenuHelp(
              "settings",
              "Pick a fill color. Double-click a swatch to edit, click x to remove, and + to add."
            ),
            renderFillColorGrid()
          ),
          h("div", { class: "menu-divider" }),
          h(
            "div",
            { class: "menu-section-label", ...withMenuHelp("settings", "Configure the stamp shape and size.") },
            "Stamp"
          ),
          h("div", withMenuHelp("settings", "Choose stamp shape and adjust stamp size."), renderStampControls()),
          h("div", { class: "menu-divider" }),
          h(
            "div",
            withMenuHelp("settings", "Adjust the stroke thickness used by the Ink tool."),
            renderInkThicknessControl()
          ),
          h("div", { class: "menu-divider" }),
          h(
            "div",
            withMenuHelp("settings", "Adjust opacity for newly created fill regions."),
            renderFillAlphaControl()
          ),
          h("div", { class: "menu-divider" }),
          renderMenuHelp("settings")
        )
      ),
      h(
        "div",
        {
          class: `menu-group menu-group-end ${openMenu.value === "grid" ? "open" : ""}`,
          "data-menu-id": "grid",
          onMouseEnter: () => openHoverMenu("grid"),
          onMouseLeave: () => closeHoverMenu("grid"),
        },
        h("div", { class: "menu-trigger", onPointerDown: (event) => startTouchMenuDrag(event, "grid") }, "Grid"),
        h(
          "div",
          { class: "menu-panel menu-panel-grid" },
          h(
            "label",
            { class: "menu-toggle", ...withMenuHelp("grid", "Toggle grid visibility on the canvas.") },
            h("input", {
              type: "checkbox",
              checked: gridSettings.value.show,
              onChange: (event) => updateGrid({ show: event.target.checked }),
            }),
            "Show Grid"
          ),
          h(
            "label",
            { class: "menu-toggle", ...withMenuHelp("grid", "Snap new points to the current grid intersections.") },
            h("input", {
              type: "checkbox",
              checked: gridSettings.value.snap,
              onChange: (event) => updateGrid({ snap: event.target.checked }),
            }),
            "Snap to Grid"
          ),
          h("div", { class: "menu-divider" }),
          h(
            "div",
            { class: "menu-slider", ...withMenuHelp("grid", "Set spacing between grid steps.") },
            h("span", { class: "menu-label" }, "Size"),
            h("input", {
              type: "range",
              min: 10,
              max: 160,
              step: 5,
              value: gridSettings.value.size,
              onInput: (event) => updateGrid({ size: Number(event.target.value) }),
            }),
            h("span", { class: "menu-slider-value" }, `${gridSettings.value.size}px`)
          ),
          h("div", { class: "menu-divider" }),
          h(
            "div",
            {
              class: "menu-item has-submenu",
              tabIndex: 0,
              role: "menuitem",
              ...withMenuHelp("grid", "Choose the geometric pattern used for the grid."),
            },
            h("span", null, "Pattern"),
            h("span", { class: "submenu-caret" }, ">"),
            h(
              "div",
              { class: "menu-submenu" },
              h(
                "button",
                {
                  type: "button",
                  class: `menu-action ${gridSettings.value.pattern === "square" ? "selected" : ""}`,
                  ...withMenuHelp("grid", "Use a square grid pattern."),
                  onClick: () => runMenuAction(() => updateGrid({ pattern: "square" })),
                },
                h("span", null, "Square")
              ),
              h(
                "button",
                {
                  type: "button",
                  class: `menu-action ${gridSettings.value.pattern === "hex" ? "selected" : ""}`,
                  ...withMenuHelp("grid", "Use a hexagonal grid pattern."),
                  onClick: () => runMenuAction(() => updateGrid({ pattern: "hex" })),
                },
                h("span", null, "Hex")
              ),
              h(
                "button",
                {
                  type: "button",
                  class: `menu-action ${gridSettings.value.pattern === "triangle" ? "selected" : ""}`,
                  ...withMenuHelp("grid", "Use a triangular grid pattern."),
                  onClick: () => runMenuAction(() => updateGrid({ pattern: "triangle" })),
                },
                h("span", null, "Triangle")
              )
            )
          ),
          h(
            "div",
            {
              class: "menu-item has-submenu",
              tabIndex: 0,
              role: "menuitem",
              ...withMenuHelp("grid", "Choose whether grid marks render as lines or dots."),
            },
            h("span", null, "Style"),
            h("span", { class: "submenu-caret" }, ">"),
            h(
              "div",
              { class: "menu-submenu" },
              h(
                "button",
                {
                  type: "button",
                  class: `menu-action ${gridSettings.value.style === "lines" ? "selected" : ""}`,
                  ...withMenuHelp("grid", "Render the grid as lines."),
                  onClick: () => runMenuAction(() => updateGrid({ style: "lines" })),
                },
                h("span", null, "Lines")
              ),
              h(
                "button",
                {
                  type: "button",
                  class: `menu-action ${gridSettings.value.style === "dots" ? "selected" : ""}`,
                  ...withMenuHelp("grid", "Render the grid as dots."),
                  onClick: () => runMenuAction(() => updateGrid({ style: "dots" })),
                },
                h("span", null, "Dots")
              )
            )
          ),
          h("div", { class: "menu-divider" }),
          renderMenuHelp("grid")
        )
      ),
      h(
        "div",
        {
          class: `menu-group menu-group-end ${openMenu.value === "view" ? "open" : ""}`,
          "data-menu-id": "view",
          onMouseEnter: () => openHoverMenu("view"),
          onMouseLeave: () => closeHoverMenu("view"),
        },
        h("div", { class: "menu-trigger", onPointerDown: (event) => startTouchMenuDrag(event, "view") }, "View"),
        h(
          "div",
          { class: "menu-panel" },
          h(
            "label",
            { class: "menu-toggle", ...withMenuHelp("view", "Show or hide the floating Tool Palette window.") },
            h("input", {
              type: "checkbox",
              checked: showToolPalette.value,
              onChange: (event) => toggleToolPalette(event.target.checked),
            }),
            "Tool Palette"
          ),
          h(
            "label",
            { class: "menu-toggle", ...withMenuHelp("view", "Show or hide the floating Fill Colors palette.") },
            h("input", {
              type: "checkbox",
              checked: showFillPalette.value,
              onChange: (event) => toggleFillPalette(event.target.checked),
            }),
            "Fill Colors Palette"
          ),
          h(
            "label",
            { class: "menu-toggle", ...withMenuHelp("view", "Show or hide the floating Stamp palette.") },
            h("input", {
              type: "checkbox",
              checked: showStampPalette.value,
              onChange: (event) => toggleStampPalette(event.target.checked),
            }),
            "Stamp Palette"
          ),
          h(
            "label",
            { class: "menu-toggle", ...withMenuHelp("view", "Toggle guide geometry and intersection markers.") },
            h("input", {
              type: "checkbox",
              checked: showGuides.value,
              onChange: (event) => toggleGuides(event.target.checked),
            }),
            "Show Guides"
          ),
          h("div", { class: "menu-divider" }),
          h(
            "div",
            { class: "menu-zoom-row", ...withMenuHelp("view", "Shows the current zoom percentage.") },
            h("span", { class: "menu-label" }, "Zoom"),
            h("span", { class: "menu-slider-value" }, `${Math.round(zoomValue.value * 100)}%`)
          ),
          h(
            "div",
            { class: "menu-zoom-actions" },
            h(
              "button",
              {
                type: "button",
                class: "zoom-btn",
                ...withMenuHelp("view", "Zoom out."),
                onClick: () => runMenuAction(() => zoomBy(1 / 1.1)),
                title: "Zoom Out (-)",
              },
              "-"
            ),
            h(
              "button",
              {
                type: "button",
                class: "zoom-btn",
                ...withMenuHelp("view", "Zoom in."),
                onClick: () => runMenuAction(() => zoomBy(1.1)),
                title: "Zoom In (+)",
              },
              "+"
            ),
            h(
              "button",
              {
                type: "button",
                class: "zoom-btn",
                ...withMenuHelp("view", "Reset zoom to 100% and center pan."),
                onClick: () => runMenuAction(() => resetZoom()),
                title: "Reset Zoom (0)",
              },
              "0"
            )
          ),
          h("div", { class: "menu-divider" }),
          renderMenuHelp("view")
        )
      )
    ),
    showToolPalette.value
      ? renderPaletteWindow({
          id: "tools",
          title: "Tools",
          className: "tool-palette",
          position: toolPalettePosition.value,
          onClose: () => toggleToolPalette(false),
          children: h(
            "div",
            { class: "tool-palette-content" },
            h(
              "div",
              { class: "tool-grid" },
              toolDefs.map((def) =>
                h(
                  "button",
                  {
                    type: "button",
                    class: `tool-btn ${tool.value === def.id ? "active" : ""}`,
                    onClick: () => setTool(def.id),
                    title: `${def.label} (${def.key})`,
                    "aria-label": `${def.label} (${def.key})`,
                  },
                  h(ToolIcon, { Icon: def.Icon, size: 20 })
                )
              )
            ),
            h("p", { class: "tool-help-text" }, getToolHelpText())
          ),
        })
      : null,
    showFillPalette.value
      ? renderPaletteWindow({
          id: "fill-colors",
          title: "Fill Colors",
          className: "fill-palette",
          position: fillPalettePosition.value,
          onClose: () => toggleFillPalette(false),
          children: h(
            "div",
            { class: "controls" },
            h("label", null, "Fill Colors"),
            renderFillColorGrid({ editable: true, editInputId: paletteEditInputId })
          ),
        })
      : null,
    showStampPalette.value
      ? renderPaletteWindow({
          id: "stamp",
          title: "Stamp",
          className: "stamp-palette",
          position: stampPalettePosition.value,
          onClose: () => toggleStampPalette(false),
          children: renderStampControls(),
        })
      : null,
    showInfoDialog.value
      ? h(
          "div",
          {
            class: "info-overlay",
            role: "dialog",
            "aria-modal": "true",
            "aria-labelledby": "info-title",
            onPointerDown: (event) => {
              if (event.target === event.currentTarget) {
                closeInfoDialog();
              }
            },
          },
          h(
            "div",
            { class: "info-popup" },
            h(
              "div",
              { class: "info-header" },
              h("h2", { id: "info-title", class: "info-title" }, APP_TITLE),
              h(
                "button",
                {
                  type: "button",
                  class: "info-close",
                  onClick: () => closeInfoDialog(),
                  "aria-label": "Close info",
                },
                "×"
              )
            ),
            h(
              "p",
              { class: "info-text" },
              "Draw lines and circles, ink spans between intersections or endpoints, and add color to the areas surrounded by ink."
            ),
            h(
              "p",
              { class: "info-text" },
              "Use Tool menu or keys 1-9 and D to switch tools. Click to place points and snap to intersections."
            ),
            h(
              "p",
              { class: "info-text" },
              "Space or middle-drag pans. Wheel zooms. Z/Y undo-redo. X clears. +/- zoom. 0 resets zoom."
            ),
            h(
              "div",
              { class: "info-actions" },
              h(
                "button",
                {
                  type: "button",
                  class: "info-btn",
                  onClick: () => closeInfoDialog(),
                },
                "Start"
              )
            )
          )
        )
      : null,
    showSaveDialog.value
      ? h(
          "div",
          {
            class: "info-overlay save-overlay",
            role: "dialog",
            "aria-modal": "true",
            "aria-labelledby": "save-title",
            onPointerDown: (event) => {
              if (event.target === event.currentTarget) {
                closeSaveDialog();
              }
            },
          },
          h(
            "div",
            { class: "info-popup save-popup" },
            h(
              "div",
              { class: "info-header" },
              h("h2", { id: "save-title", class: "info-title" }, "Save Drawing"),
              h(
                "button",
                {
                  type: "button",
                  class: "info-close",
                  onClick: () => closeSaveDialog(),
                  "aria-label": "Close save dialog",
                },
                "×"
              )
            ),
            h("p", { class: "info-text save-text" }, "Choose a filename for the JSON download."),
            h(
              "div",
              { class: "save-field" },
              h("label", { class: "save-label", for: "save-file-name" }, "Filename"),
              h("input", {
                id: "save-file-name",
                class: "save-input",
                type: "text",
                value: saveDialogFileName.value,
                spellCheck: false,
                autoComplete: "off",
                onInput: (event) => {
                  saveDialogFileName.value = event.target.value;
                },
                onKeyDown: (event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    handleSaveDialogSubmit();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    closeSaveDialog();
                  }
                },
              })
            ),
            h(
              "div",
              { class: "info-actions save-actions" },
              h(
                "button",
                {
                  type: "button",
                  class: "save-btn save-btn-secondary",
                  onClick: () => closeSaveDialog(),
                },
                "Cancel"
              ),
              h(
                "button",
                {
                  type: "button",
                  class: "info-btn",
                  onClick: () => handleSaveDialogSubmit(),
                },
                "Save"
              )
            )
          )
        )
      : null,
    h(
      "div",
      { class: "mobile-footer-toolbar", role: "toolbar", "aria-label": "Mobile actions" },
      h(
        "button",
        {
          type: "button",
          class: "mobile-footer-btn",
          onClick: () => undo(),
          title: "Undo",
          "aria-label": "Undo",
        },
        h(ToolIcon, { Icon: RotateCcw, size: 18 })
      ),
      h(
        "button",
        {
          type: "button",
          class: "mobile-footer-btn",
          onClick: () => redo(),
          title: "Redo",
          "aria-label": "Redo",
        },
        h(ToolIcon, { Icon: RotateCw, size: 18 })
      ),
      mobileFooterToolIds.map((toolId) => {
        const def = toolDefsById.get(toolId);
        if (!def) return null;
        return h(
          "button",
          {
            type: "button",
            class: `mobile-footer-btn ${tool.value === def.id ? "active" : ""}`,
            onClick: () => setTool(def.id),
            title: def.label,
            "aria-label": def.label,
          },
          h(ToolIcon, { Icon: def.Icon, size: 18 })
        );
      })
    ),
    h(
      "div",
      { class: "hud-info" },
      h("div", { class: "status" }, status.value)
    )
  );
}

render(h(Toolbar), document.getElementById("ui"));

function setTool(id) {
  tool.value = id;
  toolState = { step: 0 };
  hoverSnap = null;
  bumpToolHelpTick();
  scheduleRender();
}

function setStatus(message, timeout = 1800) {
  status.value = message;
  if (!message) return;
  window.clearTimeout(setStatus._timer);
  setStatus._timer = window.setTimeout(() => {
    status.value = "";
  }, timeout);
}

function buildSharePayload() {
  return JSON.stringify(snapshotForShare());
}

function normalizeDrawingFileName(name) {
  const fallback = currentDrawingFileName || DEFAULT_DRAWING_FILE_NAME;
  const trimmed = typeof name === "string" ? name.trim() : "";
  const raw = trimmed || fallback;
  const noPath = raw.replace(/[/\\]/g, "-");
  const cleaned = noPath.replace(/[\u0000-\u001f:*?"<>|]/g, "-").trim();
  const baseName = cleaned || DEFAULT_DRAWING_FILE_NAME;
  if (/\.json$/i.test(baseName)) return baseName;
  return `${baseName}.json`;
}

function extractDrawingSnapshot(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Drawing JSON must contain an object.");
  }
  if (payload.format === "cag-drawing" && payload.state && typeof payload.state === "object") {
    return payload.state;
  }
  return payload;
}

function saveDrawingJsonToFileName(fileName) {
  const payload = JSON.stringify(snapshotForShare(), null, 2);
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  currentDrawingFileName = fileName;
  setStatus(`Saved ${fileName}`);
}

function openSaveDialog() {
  saveDialogFileName.value = currentDrawingFileName || DEFAULT_DRAWING_FILE_NAME;
  showSaveDialog.value = true;
  requestAnimationFrame(() => {
    const input = document.getElementById("save-file-name");
    if (!input) return;
    input.focus();
    input.select();
  });
}

function confirmSaveDialog() {
  const fileName = normalizeDrawingFileName(saveDialogFileName.value);
  saveDialogFileName.value = fileName;
  saveDrawingJsonToFileName(fileName);
  showSaveDialog.value = false;
}

function saveDrawingJson() {
  openSaveDialog();
}

async function loadDrawingJsonFromFile(file) {
  const text = await file.text();
  const parsed = JSON.parse(text);
  const snap = extractDrawingSnapshot(parsed);
  restoreShareState(snap);
  currentDrawingFileName = normalizeDrawingFileName(file.name);
  setStatus(`Loaded ${currentDrawingFileName}`);
}

function loadDrawingJson() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.addEventListener(
    "change",
    async () => {
      const [file] = input.files || [];
      if (!file) return;
      try {
        await loadDrawingJsonFromFile(file);
      } catch (error) {
        console.warn("Drawing JSON load failed", error);
        setStatus("Could not load drawing JSON.");
      }
    },
    { once: true }
  );
  input.click();
}

function encodeBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(text) {
  let base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const pad = base64.length % 4;
  if (pad) {
    base64 += "=".repeat(4 - pad);
  }
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function buildShareUrl() {
  const payload = encodeBase64Url(buildSharePayload());
  const url = new URL(window.location.href);
  url.searchParams.set("share", payload);
  return url.toString();
}

async function copyShareUrl() {
  try {
    const url = buildShareUrl();
    await copyTextToClipboard(url);
    setStatus("Share URL copied");
  } catch (error) {
    console.warn("Share URL copy failed", error);
    setStatus("Could not copy share URL.");
  }
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.left = "-9999px";
  area.style.top = "-9999px";
  document.body.appendChild(area);
  area.select();
  document.execCommand("copy");
  document.body.removeChild(area);
}

function scheduleRender() {
  if (scheduleRender._queued) return;
  scheduleRender._queued = true;
  requestAnimationFrame(() => {
    scheduleRender._queued = false;
    draw();
  });
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width * dpr));
  const height = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

function worldToScreen(point) {
  return {
    x: (point.x + view.panX) * view.scale,
    y: (point.y + view.panY) * view.scale,
  };
}

function screenToWorld(point) {
  return {
    x: point.x / view.scale - view.panX,
    y: point.y / view.scale - view.panY,
  };
}

function getWorldBounds() {
  const rect = canvas.getBoundingClientRect();
  const topLeft = screenToWorld({ x: 0, y: 0 });
  const bottomRight = screenToWorld({ x: rect.width, y: rect.height });
  return {
    minX: Math.min(topLeft.x, bottomRight.x),
    minY: Math.min(topLeft.y, bottomRight.y),
    maxX: Math.max(topLeft.x, bottomRight.x),
    maxY: Math.max(topLeft.y, bottomRight.y),
    width: Math.abs(bottomRight.x - topLeft.x),
    height: Math.abs(bottomRight.y - topLeft.y),
  };
}

function getRasterScale() {
  return view.scale * (window.devicePixelRatio || 1);
}

function clampScale(scale) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
}

function applyZoom(nextScale, screenPoint) {
  const rect = canvas.getBoundingClientRect();
  const screen = screenPoint ?? { x: rect.width / 2, y: rect.height / 2 };
  const world = screenToWorld(screen);
  view.scale = clampScale(nextScale);
  view.panX = screen.x / view.scale - world.x;
  view.panY = screen.y / view.scale - world.y;
  zoomValue.value = view.scale;
  scheduleRerasterizeFills();
  scheduleRender();
}

function zoomBy(factor, screenPoint) {
  applyZoom(view.scale * factor, screenPoint);
}

function resetZoom() {
  view.scale = 1;
  view.panX = 0;
  view.panY = 0;
  zoomValue.value = view.scale;
  scheduleRerasterizeFills();
  scheduleRender();
}

function vec(x, y) {
  return { x, y };
}

function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y };
}

function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}

function mul(a, s) {
  return { x: a.x * s, y: a.y * s };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y;
}

function cross(a, b) {
  return a.x * b.y - a.y * b.x;
}

function len(a) {
  return Math.hypot(a.x, a.y);
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function regularPolygonVertices(center, sides, radius, rotation = 0) {
  const verts = [];
  const step = (Math.PI * 2) / sides;
  for (let i = 0; i < sides; i += 1) {
    const angle = rotation + step * i;
    verts.push({
      x: center.x + radius * Math.cos(angle),
      y: center.y + radius * Math.sin(angle),
    });
  }
  return verts;
}

function getStampVertices(center, shape, size) {
  if (shape === "square") {
    const radius = size / Math.SQRT2;
    return regularPolygonVertices(center, 4, radius, Math.PI / 4);
  }
  if (shape === "triangle") {
    const radius = size / Math.sqrt(3);
    return regularPolygonVertices(center, 3, radius, -Math.PI / 2);
  }
  if (shape === "hex") {
    return regularPolygonVertices(center, 6, size, 0);
  }
  return null;
}

function normalizeAngle(angle) {
  let a = angle % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a;
}

function angleInArc(angle, start, end) {
  const a = normalizeAngle(angle);
  const s = normalizeAngle(start);
  const e = normalizeAngle(end);
  if (s <= e) return a >= s - EPS && a <= e + EPS;
  return a >= s - EPS || a <= e + EPS;
}

function angleOnArc(angle, start, end, ccw) {
  if (ccw) return angleInArc(angle, end, start);
  return angleInArc(angle, start, end);
}

function lineParam(line, point) {
  const d = sub(line.p1, line.p0);
  const denom = dot(d, d);
  if (denom < EPS) return 0;
  return dot(sub(point, line.p0), d) / denom;
}

function closestPointOnLine(line, point) {
  const t = lineParam(line, point);
  const d = sub(line.p1, line.p0);
  return add(line.p0, mul(d, t));
}

function closestPointOnSegment(segment, point) {
  const d = sub(segment.p1, segment.p0);
  const denom = dot(d, d);
  if (denom < EPS) return segment.p0;
  const t = Math.max(0, Math.min(1, dot(sub(point, segment.p0), d) / denom));
  return add(segment.p0, mul(d, t));
}

function closestPointOnCircle(circle, point) {
  const r = dist(circle.c, circle.rp);
  const angle = Math.atan2(point.y - circle.c.y, point.x - circle.c.x);
  return {
    x: circle.c.x + Math.cos(angle) * r,
    y: circle.c.y + Math.sin(angle) * r,
  };
}

function distancePointToSegment(point, a, b) {
  const ab = sub(b, a);
  const denom = dot(ab, ab);
  if (denom < EPS) return dist(point, a);
  const t = Math.max(0, Math.min(1, dot(sub(point, a), ab) / denom));
  const proj = add(a, mul(ab, t));
  return dist(point, proj);
}

function closestPointOnArc(arc, point) {
  const r = dist(arc.c, arc.rp);
  const rawAngle = Math.atan2(point.y - arc.c.y, point.x - arc.c.x);
  const angle = normalizeAngle(rawAngle);
  if (angleInArc(angle, arc.startAngle, arc.endAngle)) {
    return {
      x: arc.c.x + Math.cos(angle) * r,
      y: arc.c.y + Math.sin(angle) * r,
    };
  }
  const start = normalizeAngle(arc.startAngle);
  const end = normalizeAngle(arc.endAngle);
  const distToStart = angleDistance(start, angle);
  const distToEnd = angleDistance(end, angle);
  const chosen = distToStart < distToEnd ? start : end;
  return {
    x: arc.c.x + Math.cos(chosen) * r,
    y: arc.c.y + Math.sin(chosen) * r,
  };
}

function angleDistance(a, b) {
  const diff = Math.abs(normalizeAngle(a) - normalizeAngle(b));
  return Math.min(diff, Math.PI * 2 - diff);
}

function arcEndpoints(arc) {
  const r = dist(arc.c, arc.rp);
  return {
    start: {
      x: arc.c.x + Math.cos(arc.startAngle) * r,
      y: arc.c.y + Math.sin(arc.startAngle) * r,
    },
    end: {
      x: arc.c.x + Math.cos(arc.endAngle) * r,
      y: arc.c.y + Math.sin(arc.endAngle) * r,
    },
    radius: r,
  };
}

function projectToRadius(center, point, radius) {
  const angle = Math.atan2(point.y - center.y, point.x - center.x);
  return {
    point: {
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    },
    angle: normalizeAngle(angle),
  };
}

function computeArcAngles(center, startPoint, endPoint, radius) {
  const start = projectToRadius(center, startPoint, radius);
  const end = projectToRadius(center, endPoint, radius);
  let startAngle = start.angle;
  let endAngle = end.angle;
  const delta = normalizeAngle(endAngle - startAngle);
  if (delta > Math.PI) {
    const temp = startAngle;
    startAngle = endAngle;
    endAngle = temp;
  }
  return { startAngle, endAngle, startPoint: start.point, endPoint: end.point };
}

function isCirclePrimitive(prim) {
  return prim.type === "circle" || prim.type === "measure" || prim.type === "arc";
}

function isArcPrimitive(prim) {
  return prim.type === "arc" || prim.type === "measure";
}

function isLineLike(prim) {
  return prim.type === "line" || prim.type === "segment";
}

function isSegment(prim) {
  return prim.type === "segment";
}

function paramOnSegment(param) {
  return param >= -EPS && param <= 1 + EPS;
}

function circleData(prim) {
  return { c: prim.c, r: dist(prim.c, prim.rp) };
}

function clipLineToBounds(line, bounds) {
  const dx = line.p1.x - line.p0.x;
  const dy = line.p1.y - line.p0.y;
  const points = [];

  if (Math.abs(dx) > EPS) {
    let t = (bounds.minX - line.p0.x) / dx;
    let y = line.p0.y + t * dy;
    if (y >= bounds.minY - EPS && y <= bounds.maxY + EPS) {
      points.push({ x: bounds.minX, y, t });
    }
    t = (bounds.maxX - line.p0.x) / dx;
    y = line.p0.y + t * dy;
    if (y >= bounds.minY - EPS && y <= bounds.maxY + EPS) {
      points.push({ x: bounds.maxX, y, t });
    }
  }

  if (Math.abs(dy) > EPS) {
    let t = (bounds.minY - line.p0.y) / dy;
    let x = line.p0.x + t * dx;
    if (x >= bounds.minX - EPS && x <= bounds.maxX + EPS) {
      points.push({ x, y: bounds.minY, t });
    }
    t = (bounds.maxY - line.p0.y) / dy;
    x = line.p0.x + t * dx;
    if (x >= bounds.minX - EPS && x <= bounds.maxX + EPS) {
      points.push({ x, y: bounds.maxY, t });
    }
  }

  const unique = [];
  for (const p of points) {
    if (!unique.some((u) => dist(u, p) < 0.5)) unique.push(p);
  }

  if (unique.length < 2) return null;

  unique.sort((a, b) => a.t - b.t);
  return {
    min: unique[0],
    max: unique[unique.length - 1],
  };
}

function computeLineLineIntersections(a, b) {
  const p = a.p0;
  const r = sub(a.p1, a.p0);
  const q = b.p0;
  const s = sub(b.p1, b.p0);
  const rxs = cross(r, s);
  if (Math.abs(rxs) < EPS) return [];
  const qmp = sub(q, p);
  const t = cross(qmp, s) / rxs;
  const u = cross(qmp, r) / rxs;
  const point = add(p, mul(r, t));
  return [{ point, paramA: t, paramB: u }];
}

function computeLineCircleIntersections(line, circle) {
  const d = sub(line.p1, line.p0);
  const f = sub(line.p0, circle.c);
  const r = circle.r;
  const a = dot(d, d);
  const b = 2 * dot(f, d);
  const c = dot(f, f) - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < -EPS) return [];
  if (Math.abs(disc) <= EPS) {
    const t = -b / (2 * a);
    const point = add(line.p0, mul(d, t));
    const angle = normalizeAngle(Math.atan2(point.y - circle.c.y, point.x - circle.c.x));
    return [{ point, paramLine: t, paramCircle: angle }];
  }
  const sqrt = Math.sqrt(disc);
  const t1 = (-b - sqrt) / (2 * a);
  const t2 = (-b + sqrt) / (2 * a);
  const point1 = add(line.p0, mul(d, t1));
  const point2 = add(line.p0, mul(d, t2));
  const angle1 = normalizeAngle(Math.atan2(point1.y - circle.c.y, point1.x - circle.c.x));
  const angle2 = normalizeAngle(Math.atan2(point2.y - circle.c.y, point2.x - circle.c.x));
  return [
    { point: point1, paramLine: t1, paramCircle: angle1 },
    { point: point2, paramLine: t2, paramCircle: angle2 },
  ];
}

function computeCircleCircleIntersections(a, b) {
  const c1 = a.c;
  const r1 = a.r;
  const c2 = b.c;
  const r2 = b.r;
  const d = dist(c1, c2);
  if (d < EPS && Math.abs(r1 - r2) < EPS) return [];
  if (d > r1 + r2 + EPS) return [];
  if (d < Math.abs(r1 - r2) - EPS) return [];
  const aLen = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const hSq = r1 * r1 - aLen * aLen;
  if (hSq < -EPS) return [];
  const h = Math.sqrt(Math.max(0, hSq));
  const mid = {
    x: c1.x + (aLen * (c2.x - c1.x)) / d,
    y: c1.y + (aLen * (c2.y - c1.y)) / d,
  };
  if (h < EPS) {
    const angle1 = normalizeAngle(Math.atan2(mid.y - c1.y, mid.x - c1.x));
    const angle2 = normalizeAngle(Math.atan2(mid.y - c2.y, mid.x - c2.x));
    return [{ point: mid, paramA: angle1, paramB: angle2 }];
  }
  const rx = -(c2.y - c1.y) * (h / d);
  const ry = (c2.x - c1.x) * (h / d);
  const p1 = { x: mid.x + rx, y: mid.y + ry };
  const p2 = { x: mid.x - rx, y: mid.y - ry };
  const angle1a = normalizeAngle(Math.atan2(p1.y - c1.y, p1.x - c1.x));
  const angle1b = normalizeAngle(Math.atan2(p1.y - c2.y, p1.x - c2.x));
  const angle2a = normalizeAngle(Math.atan2(p2.y - c1.y, p2.x - c1.x));
  const angle2b = normalizeAngle(Math.atan2(p2.y - c2.y, p2.x - c2.x));
  return [
    { point: p1, paramA: angle1a, paramB: angle1b },
    { point: p2, paramA: angle2a, paramB: angle2b },
  ];
}

function computeIntersectionsForPair(a, b) {
  if (isLineLike(a) && isLineLike(b)) {
    return computeLineLineIntersections(a, b).filter((hit) => {
      if (isSegment(a) && !paramOnSegment(hit.paramA)) return false;
      if (isSegment(b) && !paramOnSegment(hit.paramB)) return false;
      return true;
    });
  }
  if (isLineLike(a) && isCirclePrimitive(b)) {
    const data = circleData(b);
    const hits = computeLineCircleIntersections(a, data);
    return hits
      .filter((hit) => {
        if (isSegment(a) && !paramOnSegment(hit.paramLine)) return false;
        if (b.type !== "measure" && b.type !== "arc") return true;
        return angleInArc(hit.paramCircle, b.startAngle, b.endAngle);
      })
      .map((hit) => ({ point: hit.point, paramA: hit.paramLine, paramB: hit.paramCircle }));
  }
  if (isLineLike(b) && isCirclePrimitive(a)) {
    const data = circleData(a);
    const hits = computeLineCircleIntersections(b, data);
    return hits
      .filter((hit) => {
        if (isSegment(b) && !paramOnSegment(hit.paramLine)) return false;
        if (a.type !== "measure" && a.type !== "arc") return true;
        return angleInArc(hit.paramCircle, a.startAngle, a.endAngle);
      })
      .map((hit) => ({ point: hit.point, paramA: hit.paramCircle, paramB: hit.paramLine }));
  }
  if (isCirclePrimitive(a) && isCirclePrimitive(b)) {
    const dataA = circleData(a);
    const dataB = circleData(b);
    const hits = computeCircleCircleIntersections(dataA, dataB);
    return hits
      .filter((hit) => {
        if ((a.type === "measure" || a.type === "arc") && !angleInArc(hit.paramA, a.startAngle, a.endAngle)) {
          return false;
        }
        if ((b.type === "measure" || b.type === "arc") && !angleInArc(hit.paramB, b.startAngle, b.endAngle)) {
          return false;
        }
        return true;
      })
      .map((hit) => ({ point: hit.point, paramA: hit.paramA, paramB: hit.paramB }));
  }
  return [];
}

function recomputeIntersections() {
  const list = [];
  const byPrim = new Map();
  const byId = new Map();

  for (const prim of state.primitives) {
    byPrim.set(prim.id, []);
  }

  for (let i = 0; i < state.primitives.length; i += 1) {
    for (let j = i + 1; j < state.primitives.length; j += 1) {
      const a = state.primitives[i];
      const b = state.primitives[j];
      const ordered = a.id < b.id ? [a, b] : [b, a];
      const primary = ordered[0];
      const secondary = ordered[1];
      const hits = computeIntersectionsForPair(primary, secondary);
      hits.sort((m, n) => m.paramA - n.paramA);
      hits.forEach((hit, idx) => {
        const id = `ix-${primary.id}-${secondary.id}-${idx}`;
        const entry = {
          id,
          point: hit.point,
          aId: primary.id,
          bId: secondary.id,
          aParam: hit.paramA,
          bParam: hit.paramB,
        };
        list.push(entry);
        byId.set(id, entry);
        byPrim.get(primary.id)?.push({ id, point: hit.point, param: hit.paramA });
        byPrim.get(secondary.id)?.push({ id, point: hit.point, param: hit.paramB });
      });
    }
  }

  for (const [primId, items] of byPrim.entries()) {
    items.sort((a, b) => a.param - b.param);
    byPrim.set(primId, items);
  }

  intersections = { list, byPrim, byId };
  scheduleRender();
}

function snapshotForShare() {
  return {
    primitives: state.primitives.map((p) => ({ ...p })),
    ink: state.ink.map((seg) => ({
      ...seg,
      a: seg.a ? { ...seg.a } : null,
      b: seg.b ? { ...seg.b } : null,
    })),
    fills: state.fills.map((fill) => ({
      id: fill.id,
      seed: fill.seed ? { ...fill.seed } : null,
      bounds: fill.bounds ? { ...fill.bounds } : null,
      color: fill.color,
      alpha: fill.alpha,
      boundSegIds: fill.boundSegIds ? [...fill.boundSegIds] : [],
    })),
    nextPrimId: state.nextPrimId,
    nextInkId: state.nextInkId,
    nextFillId: state.nextFillId,
    measureDistance: measureDistance.value,
  };
}

function snapshot() {
  return {
    primitives: state.primitives.map((p) => ({ ...p })),
    ink: state.ink.map((seg) => ({
      ...seg,
      a: seg.a ? { ...seg.a } : null,
      b: seg.b ? { ...seg.b } : null,
    })),
    fills: state.fills.map((fill) => ({
      id: fill.id,
      origin: { ...fill.origin },
      width: fill.width,
      height: fill.height,
      mask: new Uint8Array(fill.mask),
      color: fill.color,
      alpha: fill.alpha,
      pixelSize: fill.pixelSize,
      seed: fill.seed ? { ...fill.seed } : null,
      bounds: fill.bounds ? { ...fill.bounds } : null,
      boundSegIds: [...fill.boundSegIds],
    })),
    nextPrimId: state.nextPrimId,
    nextInkId: state.nextInkId,
    nextFillId: state.nextFillId,
    measureDistance: measureDistance.value,
  };
}

function restore(snap) {
  state.primitives = snap.primitives.map((p) => ({ ...p }));
  state.ink = snap.ink.map((seg) => ({
    ...seg,
    a: seg.a ? { ...seg.a } : null,
    b: seg.b ? { ...seg.b } : null,
  }));
  state.fills = snap.fills.map((fill) => {
    const restored = {
      ...fill,
      origin: { ...fill.origin },
      seed: fill.seed ? { ...fill.seed } : null,
      bounds: fill.bounds ? { ...fill.bounds } : null,
      mask: new Uint8Array(fill.mask),
    };
    restored.canvas = buildFillCanvas(restored);
    return restored;
  });
  state.nextPrimId = snap.nextPrimId;
  state.nextInkId = snap.nextInkId;
  state.nextFillId = snap.nextFillId;
  measureDistance.value = snap.measureDistance;
  recomputeIntersections();
  rerasterizeFills();
  scheduleRender();
}

function computeNextId(items) {
  let maxId = 0;
  items.forEach((item) => {
    if (item && Number.isFinite(item.id)) {
      maxId = Math.max(maxId, item.id);
    }
  });
  return maxId + 1;
}

function rebuildFillMasksFromShare() {
  if (!state.fills.length) return;
  const primitiveBounds = computePrimitiveBounds() || getWorldBounds();
  const inkById = new Map(state.ink.map((seg) => [seg.id, seg]));
  const rebuilt = [];
  state.fills.forEach((fill) => {
    if (!fill.seed) return;
    const segments = fill.boundSegIds?.length
      ? fill.boundSegIds.map((id) => inkById.get(id)).filter(Boolean)
      : state.ink;
    if (!segments.length) return;
    const bounds = computeBoundsForSegments(segments, primitiveBounds);
    if (!bounds) return;
    const raster = rasterizeFill(fill.seed, bounds, segments);
    if (!raster.ok) return;
    const next = {
      ...fill,
      ...raster.data,
      bounds: normalizeBounds(bounds),
      seed: { x: fill.seed.x, y: fill.seed.y },
    };
    next.canvas = buildFillCanvas(next);
    rebuilt.push(next);
  });
  state.fills = rebuilt;
}

function restoreShareState(snap) {
  state.primitives = (snap.primitives || []).map((p) => ({ ...p }));
  state.ink = (snap.ink || []).map((seg) => ({
    ...seg,
    a: seg.a ? { ...seg.a } : null,
    b: seg.b ? { ...seg.b } : null,
  }));
  state.fills = (snap.fills || []).map((fill) => ({
    id: fill.id,
    seed: fill.seed ? { ...fill.seed } : null,
    bounds: fill.bounds ? { ...fill.bounds } : null,
    color: fill.color,
    alpha: fill.alpha,
    boundSegIds: fill.boundSegIds ? [...fill.boundSegIds] : [],
  }));
  state.nextPrimId = Number.isFinite(snap.nextPrimId)
    ? snap.nextPrimId
    : computeNextId(state.primitives);
  state.nextInkId = Number.isFinite(snap.nextInkId) ? snap.nextInkId : computeNextId(state.ink);
  state.nextFillId = Number.isFinite(snap.nextFillId)
    ? snap.nextFillId
    : computeNextId(state.fills);
  measureDistance.value = snap.measureDistance ?? null;
  toolState = { step: 0 };
  hoverSnap = null;
  bumpToolHelpTick();
  history.past = [];
  history.future = [];
  recomputeIntersections();
  rebuildFillMasksFromShare();
  scheduleRender();
}

function commitHistory() {
  history.past.push(snapshot());
  history.future = [];
}

function undo() {
  if (!history.past.length) return;
  history.future.push(snapshot());
  const prev = history.past.pop();
  restore(prev);
}

function redo() {
  if (!history.future.length) return;
  history.past.push(snapshot());
  const next = history.future.pop();
  restore(next);
}

function clearAll() {
  commitHistory();
  state.primitives = [];
  state.ink = [];
  state.fills = [];
  recomputeIntersections();
}

function expandBounds(bounds, point) {
  if (!point) return bounds;
  if (!bounds) {
    return { minX: point.x, maxX: point.x, minY: point.y, maxY: point.y };
  }
  return {
    minX: Math.min(bounds.minX, point.x),
    maxX: Math.max(bounds.maxX, point.x),
    minY: Math.min(bounds.minY, point.y),
    maxY: Math.max(bounds.maxY, point.y),
  };
}

function expandBoundsRect(bounds, minX, minY, maxX, maxY) {
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return bounds;
  }
  const next = bounds ?? { minX, maxX, minY, maxY };
  return {
    minX: Math.min(next.minX, minX),
    maxX: Math.max(next.maxX, maxX),
    minY: Math.min(next.minY, minY),
    maxY: Math.max(next.maxY, maxY),
  };
}

function expandBoundsCircle(bounds, center, radius) {
  return expandBoundsRect(bounds, center.x - radius, center.y - radius, center.x + radius, center.y + radius);
}

function expandBoundsArc(bounds, center, radius, startAngle, endAngle, ccw = false) {
  const start = {
    x: center.x + Math.cos(startAngle) * radius,
    y: center.y + Math.sin(startAngle) * radius,
  };
  const end = {
    x: center.x + Math.cos(endAngle) * radius,
    y: center.y + Math.sin(endAngle) * radius,
  };
  let next = expandBounds(bounds, start);
  next = expandBounds(next, end);
  const cardinal = [0, Math.PI / 2, Math.PI, (Math.PI * 3) / 2];
  cardinal.forEach((angle) => {
    if (angleOnArc(angle, startAngle, endAngle, ccw)) {
      next = expandBounds(next, {
        x: center.x + Math.cos(angle) * radius,
        y: center.y + Math.sin(angle) * radius,
      });
    }
  });
  return next;
}

function computePrimitiveBounds() {
  let bounds = null;
  state.primitives.forEach((prim) => {
    if (prim.type === "segment") {
      bounds = expandBounds(bounds, prim.p0);
      bounds = expandBounds(bounds, prim.p1);
    }
    if (prim.type === "circle") {
      bounds = expandBoundsCircle(bounds, prim.c, dist(prim.c, prim.rp));
    }
    if (prim.type === "arc" || prim.type === "measure") {
      bounds = expandBoundsArc(bounds, prim.c, dist(prim.c, prim.rp), prim.startAngle, prim.endAngle, false);
    }
  });
  return bounds;
}

function computeBoundsForSegments(segments, fallbackBounds) {
  let bounds = null;
  segments.forEach((seg) => {
    const prim = state.primitives.find((p) => p.id === seg.primId);
    if (!prim) return;
    if (seg.kind === "circle") {
      const radius = dist(prim.c, prim.rp);
      if (seg.full) {
        if (prim.type === "circle") {
          bounds = expandBoundsCircle(bounds, prim.c, radius);
        } else if (isArcPrimitive(prim)) {
          bounds = expandBoundsArc(bounds, prim.c, radius, prim.startAngle, prim.endAngle, false);
        }
      } else {
        const angles = resolveCircularSegmentAngles(seg, prim);
        if (!angles) {
          if (prim.type === "circle") {
            bounds = expandBoundsCircle(bounds, prim.c, radius);
          } else if (isArcPrimitive(prim)) {
            bounds = expandBoundsArc(bounds, prim.c, radius, prim.startAngle, prim.endAngle, false);
          }
          return;
        }
        bounds = expandBoundsArc(bounds, prim.c, radius, angles.aAngle, angles.bAngle, seg.ccw);
      }
    }
    if (seg.kind === "line") {
      if (seg.a?.type === "intersection") {
        const aInter = intersections.byId.get(seg.a.id);
        if (aInter) bounds = expandBounds(bounds, aInter.point);
      }
      if (seg.b?.type === "intersection") {
        const bInter = intersections.byId.get(seg.b.id);
        if (bInter) bounds = expandBounds(bounds, bInter.point);
      }
      if (seg.a?.type === "endpoint" && prim.type === "segment") {
        bounds = expandBounds(bounds, seg.a.which === "start" ? prim.p0 : prim.p1);
      }
      if (seg.b?.type === "endpoint" && prim.type === "segment") {
        bounds = expandBounds(bounds, seg.b.which === "start" ? prim.p0 : prim.p1);
      }
    }
  });

  if (!bounds) {
    if (!fallbackBounds) return null;
    bounds = { ...fallbackBounds };
  }

  segments.forEach((seg) => {
    if (seg.kind !== "line") return;
    const prim = state.primitives.find((p) => p.id === seg.primId);
    if (!prim) return;
    const a = resolveLineEndpoint(seg.a, prim, bounds);
    const b = resolveLineEndpoint(seg.b, prim, bounds);
    if (!a || !b) return;
    bounds = expandBounds(bounds, a);
    bounds = expandBounds(bounds, b);
  });

  return bounds;
}

function computeExportBounds(includeGuides) {
  let bounds = null;

  state.fills.forEach((fill) => {
    const pixelSize = fill.pixelSize || 1;
    const minX = fill.origin.x;
    const minY = fill.origin.y;
    const maxX = fill.origin.x + fill.width * pixelSize;
    const maxY = fill.origin.y + fill.height * pixelSize;
    bounds = expandBoundsRect(bounds, minX, minY, maxX, maxY);
  });

  if (includeGuides) {
    state.primitives.forEach((prim) => {
      if (prim.type === "segment") {
        bounds = expandBounds(bounds, prim.p0);
        bounds = expandBounds(bounds, prim.p1);
      }
      if (prim.type === "circle") {
        bounds = expandBoundsCircle(bounds, prim.c, dist(prim.c, prim.rp));
      }
      if (prim.type === "arc" || prim.type === "measure") {
        bounds = expandBoundsArc(bounds, prim.c, dist(prim.c, prim.rp), prim.startAngle, prim.endAngle, false);
      }
    });
  }

  state.ink.forEach((seg) => {
    const prim = state.primitives.find((p) => p.id === seg.primId);
    if (!prim) return;
    if (seg.kind === "circle") {
      const radius = dist(prim.c, prim.rp);
      if (seg.full) {
        if (prim.type === "circle") {
          bounds = expandBoundsCircle(bounds, prim.c, radius);
        } else if (isArcPrimitive(prim)) {
          bounds = expandBoundsArc(bounds, prim.c, radius, prim.startAngle, prim.endAngle, false);
        }
      } else {
        const angles = resolveCircularSegmentAngles(seg, prim);
        if (!angles) return;
        bounds = expandBoundsArc(bounds, prim.c, radius, angles.aAngle, angles.bAngle, seg.ccw);
      }
    }
    if (seg.kind === "line") {
      if (seg.a?.type === "intersection") {
        const aInter = intersections.byId.get(seg.a.id);
        if (aInter) bounds = expandBounds(bounds, aInter.point);
      }
      if (seg.b?.type === "intersection") {
        const bInter = intersections.byId.get(seg.b.id);
        if (bInter) bounds = expandBounds(bounds, bInter.point);
      }
      if (seg.a?.type === "endpoint" && prim.type === "segment") {
        bounds = expandBounds(bounds, seg.a.which === "start" ? prim.p0 : prim.p1);
      }
      if (seg.b?.type === "endpoint" && prim.type === "segment") {
        bounds = expandBounds(bounds, seg.b.which === "start" ? prim.p0 : prim.p1);
      }
    }
  });

  if (!bounds) {
    const viewBounds = getWorldBounds();
    bounds = {
      minX: viewBounds.minX,
      minY: viewBounds.minY,
      maxX: viewBounds.maxX,
      maxY: viewBounds.maxY,
    };
  }

  if (includeGuides) {
    state.primitives.forEach((prim) => {
      if (prim.type !== "line") return;
      const clip = clipLineToBounds(prim, bounds);
      if (!clip) return;
      bounds = expandBounds(bounds, clip.min);
      bounds = expandBounds(bounds, clip.max);
    });
  }

  state.ink.forEach((seg) => {
    if (seg.kind !== "line") return;
    const prim = state.primitives.find((p) => p.id === seg.primId);
    if (!prim) return;
    const a = resolveLineEndpoint(seg.a, prim, bounds);
    const b = resolveLineEndpoint(seg.b, prim, bounds);
    if (!a || !b) return;
    bounds = expandBounds(bounds, a);
    bounds = expandBounds(bounds, b);
  });

  return bounds;
}

function downloadPng() {
  const includeGuides = showGuides.value;
  const bounds = computeExportBounds(includeGuides);
  if (!bounds) {
    setStatus("Nothing to export.");
    return;
  }
  const margin = 20;
  const widthWorld = Math.max(1, bounds.maxX - bounds.minX);
  const heightWorld = Math.max(1, bounds.maxY - bounds.minY);
  const scale = window.devicePixelRatio || 1;
  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = Math.max(1, Math.ceil((widthWorld + margin * 2) * scale));
  exportCanvas.height = Math.max(1, Math.ceil((heightWorld + margin * 2) * scale));
  const ectx = exportCanvas.getContext("2d");
  ectx.setTransform(1, 0, 0, 1, 0, 0);
  ectx.fillStyle = "#ffffff";
  ectx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
  const offsetX = margin - bounds.minX;
  const offsetY = margin - bounds.minY;
  ectx.setTransform(scale, 0, 0, scale, offsetX * scale, offsetY * scale);

  ectx.save();
  ectx.imageSmoothingEnabled = false;
  state.fills.forEach((fill) => {
    if (!fill.canvas) fill.canvas = buildFillCanvas(fill);
    const pixelSize = fill.pixelSize || 1;
    const w = fill.width * pixelSize;
    const h = fill.height * pixelSize;
    ectx.drawImage(fill.canvas, fill.origin.x, fill.origin.y, w, h);
  });
  ectx.restore();

  if (includeGuides) {
    ectx.save();
    ectx.strokeStyle = "#8fbef8";
    ectx.fillStyle = "#8fbef8";
    const pointRadius = 2.5;
    state.primitives.forEach((prim) => {
      if (prim.type === "line") {
        const clip = clipLineToBounds(prim, bounds);
        if (!clip) return;
        ectx.lineWidth = 1.2;
        ectx.setLineDash([]);
        ectx.beginPath();
        ectx.moveTo(clip.min.x, clip.min.y);
        ectx.lineTo(clip.max.x, clip.max.y);
        ectx.stroke();
      }
      if (prim.type === "segment") {
        ectx.lineWidth = 1.2;
        ectx.setLineDash([]);
        ectx.beginPath();
        ectx.moveTo(prim.p0.x, prim.p0.y);
        ectx.lineTo(prim.p1.x, prim.p1.y);
        ectx.stroke();
        ectx.beginPath();
        ectx.arc(prim.p0.x, prim.p0.y, pointRadius, 0, Math.PI * 2);
        ectx.fill();
        ectx.beginPath();
        ectx.arc(prim.p1.x, prim.p1.y, pointRadius, 0, Math.PI * 2);
        ectx.fill();
      }
      if (prim.type === "circle") {
        const radius = dist(prim.c, prim.rp);
        ectx.lineWidth = 1.2;
        ectx.setLineDash([]);
        ectx.beginPath();
        ectx.arc(prim.c.x, prim.c.y, radius, 0, Math.PI * 2);
        ectx.stroke();
        ectx.beginPath();
        ectx.arc(prim.c.x, prim.c.y, pointRadius, 0, Math.PI * 2);
        ectx.fill();
      }
      if (prim.type === "arc") {
        const radius = dist(prim.c, prim.rp);
        ectx.lineWidth = 1.2;
        ectx.setLineDash([]);
        ectx.beginPath();
        ectx.arc(prim.c.x, prim.c.y, radius, prim.startAngle, prim.endAngle, false);
        ectx.stroke();
        const endpoints = arcEndpoints(prim);
        ectx.beginPath();
        ectx.arc(prim.c.x, prim.c.y, pointRadius, 0, Math.PI * 2);
        ectx.fill();
        ectx.beginPath();
        ectx.arc(endpoints.start.x, endpoints.start.y, pointRadius, 0, Math.PI * 2);
        ectx.fill();
        ectx.beginPath();
        ectx.arc(endpoints.end.x, endpoints.end.y, pointRadius, 0, Math.PI * 2);
        ectx.fill();
      }
      if (prim.type === "measure") {
        const radius = dist(prim.c, prim.rp);
        ectx.lineWidth = 1.2;
        ectx.setLineDash([5, 6]);
        ectx.beginPath();
        ectx.arc(prim.c.x, prim.c.y, radius, prim.startAngle, prim.endAngle, false);
        ectx.stroke();
        ectx.setLineDash([]);
      }
    });
    ectx.restore();

    ectx.save();
    ectx.fillStyle = "#2b6bf3";
    const radius = 3;
    intersections.list.forEach((inter) => {
      ectx.beginPath();
      ectx.arc(inter.point.x, inter.point.y, radius, 0, Math.PI * 2);
      ectx.fill();
    });
    ectx.restore();
  }

  ectx.save();
  ectx.strokeStyle = "#0b0b0f";
  ectx.setLineDash([]);
  state.ink.forEach((seg) => {
    const prim = state.primitives.find((p) => p.id === seg.primId);
    if (!prim) return;
    ectx.lineWidth = seg.thickness ?? 2;
    if (seg.kind === "line") {
      const a = resolveLineEndpoint(seg.a, prim, bounds);
      const b = resolveLineEndpoint(seg.b, prim, bounds);
      if (!a || !b) return;
      ectx.beginPath();
      ectx.moveTo(a.x, a.y);
      ectx.lineTo(b.x, b.y);
      ectx.stroke();
    }
    if (seg.kind === "circle") {
      const radius = dist(prim.c, prim.rp);
      if (seg.full) {
        ectx.beginPath();
        if (prim.type === "circle") {
          ectx.arc(prim.c.x, prim.c.y, radius, 0, Math.PI * 2);
        } else if (isArcPrimitive(prim)) {
          ectx.arc(prim.c.x, prim.c.y, radius, prim.startAngle, prim.endAngle, false);
        } else {
          return;
        }
        ectx.stroke();
      } else {
        const angles = resolveCircularSegmentAngles(seg, prim);
        if (!angles) return;
        ectx.beginPath();
        ectx.arc(prim.c.x, prim.c.y, radius, angles.aAngle, angles.bAngle, seg.ccw);
        ectx.stroke();
      }
    }
  });
  ectx.restore();

  const link = document.createElement("a");
  link.href = exportCanvas.toDataURL("image/png");
  link.download = "cag-drawing.png";
  link.click();
}

function setStrokeWidth(px) {
  ctx.lineWidth = px / view.scale;
}

function drawLine(line, strokeStyle, lineWidthPx, dashed = false) {
  const bounds = getWorldBounds();
  const clip = clipLineToBounds(line, bounds);
  if (!clip) return;
  ctx.save();
  ctx.strokeStyle = strokeStyle;
  setStrokeWidth(lineWidthPx);
  if (dashed) {
    ctx.setLineDash([6 / view.scale, 6 / view.scale]);
  } else {
    ctx.setLineDash([]);
  }
  ctx.beginPath();
  ctx.moveTo(clip.min.x, clip.min.y);
  ctx.lineTo(clip.max.x, clip.max.y);
  ctx.stroke();
  ctx.restore();
}

function drawSegment(segment, strokeStyle, lineWidthPx, dashed = false) {
  ctx.save();
  ctx.strokeStyle = strokeStyle;
  setStrokeWidth(lineWidthPx);
  if (dashed) {
    ctx.setLineDash([6 / view.scale, 6 / view.scale]);
  } else {
    ctx.setLineDash([]);
  }
  ctx.beginPath();
  ctx.moveTo(segment.p0.x, segment.p0.y);
  ctx.lineTo(segment.p1.x, segment.p1.y);
  ctx.stroke();
  ctx.restore();
}

function drawCircle(circle, strokeStyle, lineWidthPx, dashed = false) {
  const radius = dist(circle.c, circle.rp);
  ctx.save();
  ctx.strokeStyle = strokeStyle;
  setStrokeWidth(lineWidthPx);
  if (dashed) {
    ctx.setLineDash([6 / view.scale, 6 / view.scale]);
  } else {
    ctx.setLineDash([]);
  }
  ctx.beginPath();
  ctx.arc(circle.c.x, circle.c.y, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawMeasure(arc, strokeStyle, lineWidthPx, dashed = true) {
  const radius = dist(arc.c, arc.rp);
  ctx.save();
  ctx.strokeStyle = strokeStyle;
  setStrokeWidth(lineWidthPx);
  if (dashed) {
    ctx.setLineDash([5 / view.scale, 6 / view.scale]);
  } else {
    ctx.setLineDash([]);
  }
  ctx.beginPath();
  ctx.arc(arc.c.x, arc.c.y, radius, arc.startAngle, arc.endAngle, false);
  ctx.stroke();
  ctx.restore();
}

function drawArcPrimitive(arc, strokeStyle, lineWidthPx, dashed = false) {
  const radius = dist(arc.c, arc.rp);
  ctx.save();
  ctx.strokeStyle = strokeStyle;
  setStrokeWidth(lineWidthPx);
  if (dashed) {
    ctx.setLineDash([6 / view.scale, 6 / view.scale]);
  } else {
    ctx.setLineDash([]);
  }
  ctx.beginPath();
  ctx.arc(arc.c.x, arc.c.y, radius, arc.startAngle, arc.endAngle, false);
  ctx.stroke();
  ctx.restore();
}

function resolveLineEndpoint(endpoint, line, bounds) {
  if (endpoint.type === "intersection") {
    const inter = intersections.byId.get(endpoint.id);
    return inter?.point ?? null;
  }
  if (endpoint.type === "endpoint") {
    if (line.type !== "segment") return null;
    return endpoint.which === "start" ? line.p0 : line.p1;
  }
  if (endpoint.type === "clip") {
    if (line.type !== "line") return null;
    const clip = clipLineToBounds(line, bounds);
    if (!clip) return null;
    return endpoint.which === "min" ? clip.min : clip.max;
  }
  return null;
}

function intersectionParamForPrim(intersection, primId) {
  if (intersection.aId === primId) return intersection.aParam;
  if (intersection.bId === primId) return intersection.bParam;
  return null;
}

function resolveCircularEndpointAngle(endpoint, prim) {
  if (!endpoint) return null;
  if (endpoint.type === "intersection") {
    const inter = intersections.byId.get(endpoint.id);
    if (!inter) return null;
    const param = intersectionParamForPrim(inter, prim.id);
    if (Number.isFinite(param)) return normalizeAngle(param);
    return normalizeAngle(Math.atan2(inter.point.y - prim.c.y, inter.point.x - prim.c.x));
  }
  if (endpoint.type === "endpoint") {
    if (!isArcPrimitive(prim)) return null;
    if (endpoint.which === "start") return normalizeAngle(prim.startAngle);
    if (endpoint.which === "end") return normalizeAngle(prim.endAngle);
  }
  return null;
}

function resolveCircularSegmentAngles(seg, prim) {
  const aAngle = resolveCircularEndpointAngle(seg.a, prim);
  const bAngle = resolveCircularEndpointAngle(seg.b, prim);
  if (aAngle === null || bAngle === null) return null;
  return { aAngle, bAngle };
}

function circularEndpointKey(endpoint) {
  if (endpoint?.type === "intersection") return `i:${endpoint.id}`;
  if (endpoint?.type === "endpoint") return `e:${endpoint.which}`;
  return "none";
}

function drawInkSegment(seg) {
  const prim = state.primitives.find((p) => p.id === seg.primId);
  if (!prim) return;
  ctx.save();
  ctx.strokeStyle = "#0b0b0f";
  setStrokeWidth(seg.thickness ?? 2);
  ctx.setLineDash([]);

  if (seg.kind === "line") {
    const bounds = getWorldBounds();
    const a = resolveLineEndpoint(seg.a, prim, bounds);
    const b = resolveLineEndpoint(seg.b, prim, bounds);
    if (!a || !b) {
      ctx.restore();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  if (seg.kind === "circle") {
    const radius = dist(prim.c, prim.rp);
    if (seg.full) {
      ctx.beginPath();
      if (prim.type === "circle") {
        ctx.arc(prim.c.x, prim.c.y, radius, 0, Math.PI * 2);
      } else if (isArcPrimitive(prim)) {
        ctx.arc(prim.c.x, prim.c.y, radius, prim.startAngle, prim.endAngle, false);
      } else {
        ctx.restore();
        return;
      }
      ctx.stroke();
    } else {
      const angles = resolveCircularSegmentAngles(seg, prim);
      if (!angles) {
        ctx.restore();
        return;
      }
      ctx.beginPath();
      ctx.arc(prim.c.x, prim.c.y, radius, angles.aAngle, angles.bAngle, seg.ccw);
      ctx.stroke();
    }
  }

  ctx.restore();
}

function drawIntersections() {
  ctx.save();
  ctx.fillStyle = "#2b6bf3";
  const radius = 3 / view.scale;
  intersections.list.forEach((inter) => {
    ctx.beginPath();
    ctx.arc(inter.point.x, inter.point.y, radius, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.restore();
}

function drawPolygon(vertices, strokeStyle, lineWidthPx, dashed = false) {
  if (!vertices || vertices.length < 2) return;
  ctx.save();
  ctx.strokeStyle = strokeStyle;
  setStrokeWidth(lineWidthPx);
  if (dashed) {
    ctx.setLineDash([6 / view.scale, 6 / view.scale]);
  } else {
    ctx.setLineDash([]);
  }
  ctx.beginPath();
  ctx.moveTo(vertices[0].x, vertices[0].y);
  for (let i = 1; i < vertices.length; i += 1) {
    ctx.lineTo(vertices[i].x, vertices[i].y);
  }
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

function drawPreview() {
  ctx.save();
  ctx.strokeStyle = "#2b6bf3";
  ctx.fillStyle = "#2b6bf3";
  const pointRadius = 3.5 / view.scale;
  const pending = toolState;
  const snapped = hoverSnap?.center || hoverSnap?.point || pointerWorld;

  if (tool.value === "compass" && pending.center) {
    drawCircle({ c: pending.center, rp: snapped }, "#2b6bf3", 1.5, true);
    ctx.beginPath();
    ctx.arc(pending.center.x, pending.center.y, pointRadius, 0, Math.PI * 2);
    ctx.fill();
  }

  if (tool.value === "straightedge" && pending.anchor) {
    drawLine({ p0: pending.anchor, p1: snapped }, "#2b6bf3", 1.5, true);
    ctx.beginPath();
    ctx.arc(pending.anchor.x, pending.anchor.y, pointRadius, 0, Math.PI * 2);
    ctx.fill();
  }

  if (tool.value === "segment" && pending.anchor) {
    drawSegment({ p0: pending.anchor, p1: snapped }, "#2b6bf3", 1.5, true);
    ctx.beginPath();
    ctx.arc(pending.anchor.x, pending.anchor.y, pointRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(snapped.x, snapped.y, pointRadius, 0, Math.PI * 2);
    ctx.fill();
  }

  if (tool.value === "arc" && pending.center) {
    ctx.beginPath();
    ctx.arc(pending.center.x, pending.center.y, pointRadius, 0, Math.PI * 2);
    ctx.fill();
    if (!pending.start) {
      if (touchDrawGesture?.kind === "arc-radius") {
        drawCircle({ c: pending.center, rp: snapped }, "#2b6bf3", 1.5, true);
      } else if (Number.isFinite(pending.radius) && pending.radius > 0) {
        drawCircle(
          {
            c: pending.center,
            rp: { x: pending.center.x + pending.radius, y: pending.center.y },
          },
          "#8fbef8",
          1.2,
          true
        );
      }
    }
    if (pending.start) {
      const radius = pending.radius ?? dist(pending.center, pending.start);
      const angles = computeArcAngles(pending.center, pending.start, snapped, radius);
      drawArcPrimitive(
        {
          c: pending.center,
          rp: angles.startPoint,
          startAngle: angles.startAngle,
          endAngle: angles.endAngle,
        },
        "#8fbef8",
        1.5,
        true
      );
      ctx.beginPath();
      ctx.arc(angles.startPoint.x, angles.startPoint.y, pointRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(angles.endPoint.x, angles.endPoint.y, pointRadius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (tool.value === "stamp") {
    const size = stampSize.value;
    if (stampShape.value === "circle") {
      drawCircle({ c: snapped, rp: { x: snapped.x + size, y: snapped.y } }, "#8fbef8", 1.5, true);
      ctx.save();
      ctx.fillStyle = "#8fbef8";
      ctx.beginPath();
      ctx.arc(snapped.x, snapped.y, pointRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else {
      const verts = getStampVertices(snapped, stampShape.value, size);
      drawPolygon(verts, "#8fbef8", 1.5, true);
    }
  }

  if (tool.value === "copy" && pending.p0) {
    ctx.setLineDash([6 / view.scale, 6 / view.scale]);
    ctx.beginPath();
    ctx.moveTo(pending.p0.x, pending.p0.y);
    ctx.lineTo(snapped.x, snapped.y);
    setStrokeWidth(1.5);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(pending.p0.x, pending.p0.y, pointRadius, 0, Math.PI * 2);
    ctx.fill();
  }

  if (tool.value === "paste" && pending.center && measureDistance.value) {
    const radius = measureDistance.value;
    drawCircle({ c: pending.center, rp: { x: pending.center.x + radius, y: pending.center.y } }, "#2b6bf3", 1.2, true);
    const angle = Math.atan2(snapped.y - pending.center.y, snapped.x - pending.center.x);
    const startAngle = normalizeAngle(angle - ARC_SPAN / 2);
    const endAngle = normalizeAngle(angle + ARC_SPAN / 2);
    ctx.save();
    ctx.strokeStyle = "#2b6bf3";
    setStrokeWidth(1.5);
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(pending.center.x, pending.center.y, radius, startAngle, endAngle, false);
    ctx.stroke();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(pending.center.x, pending.center.y, pointRadius, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

function drawSnapHighlight() {
  if (!hoverSnap) return;
  ctx.save();
  ctx.strokeStyle = "#ff9f1c";
  setStrokeWidth(1.5);
  ctx.beginPath();
  ctx.arc(hoverSnap.point.x, hoverSnap.point.y, 5 / view.scale, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawGrid() {
  const settings = gridSettings.value;
  if (!settings.show) return;
  const size = settings.size;
  if (!Number.isFinite(size) || size <= 0) return;
  const bounds = getWorldBounds();
  ctx.save();
  ctx.setLineDash([]);

  if (settings.style === "lines") {
    ctx.strokeStyle = GRID_COLOR;
    setStrokeWidth(1);
    if (settings.pattern === "square") {
      drawSquareGridLines(bounds, size);
    } else if (settings.pattern === "triangle") {
      drawTriangleGridLines(bounds, size);
    } else {
      drawHexGridLines(bounds, size);
    }
  } else {
    ctx.fillStyle = GRID_DOT_COLOR;
    const radius = Math.max(0.6, 1 / view.scale);
    if (settings.pattern === "square") {
      drawSquareGridDots(bounds, size, radius);
    } else if (settings.pattern === "hex") {
      drawHexGridDots(bounds, size, radius);
    } else {
      drawTriangleGridDots(bounds, size, radius, { x: 0, y: 0 });
    }
  }

  ctx.restore();
}

function drawSquareGridLines(bounds, size) {
  const minX = Math.floor(bounds.minX / size) * size - size;
  const maxX = Math.ceil(bounds.maxX / size) * size + size;
  const minY = Math.floor(bounds.minY / size) * size - size;
  const maxY = Math.ceil(bounds.maxY / size) * size + size;

  ctx.beginPath();
  for (let x = minX; x <= maxX; x += size) {
    ctx.moveTo(x, minY);
    ctx.lineTo(x, maxY);
  }
  for (let y = minY; y <= maxY; y += size) {
    ctx.moveTo(minX, y);
    ctx.lineTo(maxX, y);
  }
  ctx.stroke();
}

function drawSquareGridDots(bounds, size, radius) {
  const minX = Math.floor(bounds.minX / size) * size - size;
  const maxX = Math.ceil(bounds.maxX / size) * size + size;
  const minY = Math.floor(bounds.minY / size) * size - size;
  const maxY = Math.ceil(bounds.maxY / size) * size + size;
  const r = radius;
  for (let x = minX; x <= maxX; x += size) {
    for (let y = minY; y <= maxY; y += size) {
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
  }
}

function drawParallelLines(bounds, angle, spacing) {
  if (spacing <= EPS) return;
  const dir = { x: Math.cos(angle), y: Math.sin(angle) };
  const normal = { x: -dir.y, y: dir.x };
  const corners = [
    { x: bounds.minX, y: bounds.minY },
    { x: bounds.minX, y: bounds.maxY },
    { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY },
  ];
  let minC = Infinity;
  let maxC = -Infinity;
  for (const corner of corners) {
    const c = normal.x * corner.x + normal.y * corner.y;
    minC = Math.min(minC, c);
    maxC = Math.max(maxC, c);
  }
  const start = Math.floor(minC / spacing) * spacing - spacing;
  const end = Math.ceil(maxC / spacing) * spacing + spacing;
  ctx.beginPath();
  for (let c = start; c <= end; c += spacing) {
    const origin = { x: normal.x * c, y: normal.y * c };
    const line = { p0: origin, p1: add(origin, dir) };
    const clip = clipLineToBounds(line, bounds);
    if (!clip) continue;
    ctx.moveTo(clip.min.x, clip.min.y);
    ctx.lineTo(clip.max.x, clip.max.y);
  }
  ctx.stroke();
}

function drawTriangleGridLines(bounds, size) {
  const spacing = (size * Math.sqrt(3)) / 2;
  drawParallelLines(bounds, 0, spacing);
  drawParallelLines(bounds, Math.PI / 3, spacing);
  drawParallelLines(bounds, -Math.PI / 3, spacing);
}

function forEachTriangularPoint(bounds, size, offset, callback) {
  const origin = offset ?? { x: 0, y: 0 };
  const h = (size * Math.sqrt(3)) / 2;
  if (h <= EPS) return;
  const minRow = Math.floor((bounds.minY - origin.y) / h) - 1;
  const maxRow = Math.ceil((bounds.maxY - origin.y) / h) + 1;
  const minCol = Math.floor((bounds.minX - origin.x) / size) - 1;
  const maxCol = Math.ceil((bounds.maxX - origin.x) / size) + 1;
  for (let row = minRow; row <= maxRow; row += 1) {
    const y = row * h + origin.y;
    const rowOffset = (Math.abs(row) % 2) * (size / 2);
    for (let col = minCol; col <= maxCol; col += 1) {
      const x = col * size + rowOffset + origin.x;
      if (x < bounds.minX - size || x > bounds.maxX + size) continue;
      callback(x, y);
    }
  }
}

function drawTriangleGridDots(bounds, size, radius, offset) {
  const r = radius;
  forEachTriangularPoint(bounds, size, offset, (x, y) => {
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  });
}

function drawHexGridLines(bounds, size) {
  ctx.beginPath();
  forEachHexCenter(bounds, size, (x, y, r) => {
    drawHexOutlinePath(x, y, r);
  });
  ctx.stroke();
}

function drawHexGridDots(bounds, size, radius) {
  const r = size;
  const h = (Math.sqrt(3) * r) / 2;
  const dot = radius;
  forEachHexCenter(bounds, size, (cx, cy) => {
    const vertices = [
      { x: cx + r, y: cy },
      { x: cx + r / 2, y: cy + h },
      { x: cx - r / 2, y: cy + h },
      { x: cx - r, y: cy },
      { x: cx - r / 2, y: cy - h },
      { x: cx + r / 2, y: cy - h },
    ];
    for (const v of vertices) {
      ctx.fillRect(v.x - dot, v.y - dot, dot * 2, dot * 2);
    }
  });
}

function forEachHexCenter(bounds, size, callback) {
  const r = size;
  const dx = r * 1.5;
  const dy = r * Math.sqrt(3);
  const minCol = Math.floor((bounds.minX - r) / dx) - 1;
  const maxCol = Math.ceil((bounds.maxX + r) / dx) + 1;
  for (let col = minCol; col <= maxCol; col += 1) {
    const x = col * dx;
    const offset = (Math.abs(col) % 2) * (dy / 2);
    const minRow = Math.floor((bounds.minY - r - offset) / dy) - 1;
    const maxRow = Math.ceil((bounds.maxY + r - offset) / dy) + 1;
    for (let row = minRow; row <= maxRow; row += 1) {
      const y = row * dy + offset;
      callback(x, y, r);
    }
  }
}

function drawHexOutlinePath(cx, cy, r) {
  for (let i = 0; i < 6; i += 1) {
    const angle = (Math.PI / 3) * i;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.closePath();
}

function draw() {
  resizeCanvas();
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(view.scale * dpr, 0, 0, view.scale * dpr, view.panX * view.scale * dpr, view.panY * view.scale * dpr);

  drawGrid();

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  state.fills.forEach((fill) => {
    if (!fill.canvas) fill.canvas = buildFillCanvas(fill);
    const pixelSize = fill.pixelSize || 1;
    const w = fill.width * pixelSize;
    const h = fill.height * pixelSize;
    ctx.drawImage(fill.canvas, fill.origin.x, fill.origin.y, w, h);
  });
  ctx.restore();

  if (showGuides.value) {
    state.primitives.forEach((prim) => {
      if (prim.type === "line") {
        drawLine(prim, "#8fbef8", 1.2);
      }
      if (prim.type === "segment") {
        drawSegment(prim, "#8fbef8", 1.2);
        ctx.save();
        ctx.fillStyle = "#8fbef8";
        ctx.beginPath();
        ctx.arc(prim.p0.x, prim.p0.y, 2.5 / view.scale, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(prim.p1.x, prim.p1.y, 2.5 / view.scale, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      if (prim.type === "circle") {
        drawCircle(prim, "#8fbef8", 1.2);
        ctx.save();
        ctx.fillStyle = "#8fbef8";
        ctx.beginPath();
        ctx.arc(prim.c.x, prim.c.y, 2.5 / view.scale, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      if (prim.type === "arc") {
        drawArcPrimitive(prim, "#8fbef8", 1.2, false);
        const endpoints = arcEndpoints(prim);
        ctx.save();
        ctx.fillStyle = "#8fbef8";
        ctx.beginPath();
        ctx.arc(prim.c.x, prim.c.y, 2.5 / view.scale, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(endpoints.start.x, endpoints.start.y, 2.5 / view.scale, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(endpoints.end.x, endpoints.end.y, 2.5 / view.scale, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      if (prim.type === "measure") {
        drawMeasure(prim, "#8fbef8", 1.2, true);
      }
    });
  }

  state.ink.forEach((seg) => drawInkSegment(seg));

  if (showGuides.value) {
    drawIntersections();
  }
  drawPreview();
  drawSnapHighlight();
}

function getNearestTriGridPoint(point, size, offset = { x: 0, y: 0 }) {
  const h = (size * Math.sqrt(3)) / 2;
  if (h <= EPS) return null;
  const shifted = { x: point.x - offset.x, y: point.y - offset.y };
  const v = shifted.y / h;
  const u = (shifted.x - (size / 2) * v) / size;
  const uRound = Math.round(u);
  const vRound = Math.round(v);
  let best = null;
  for (let du = -1; du <= 1; du += 1) {
    for (let dv = -1; dv <= 1; dv += 1) {
      const uu = uRound + du;
      const vv = vRound + dv;
      const x = size * uu + (size / 2) * vv + offset.x;
      const y = h * vv + offset.y;
      const d = dist(point, { x, y });
      if (!best || d < best.distance) {
        best = { point: { x, y }, distance: d };
      }
    }
  }
  return best;
}

function pixelToHex(point, size) {
  const q = (2 / 3) * (point.x / size);
  const r = ((-1 / 3) * point.x + (Math.sqrt(3) / 3) * point.y) / size;
  return { q, r };
}

function axialToPixel(q, r, size) {
  return {
    x: size * (1.5 * q),
    y: size * (Math.sqrt(3) / 2 * q + Math.sqrt(3) * r),
  };
}

function hexRound(q, r) {
  let x = q;
  let z = r;
  let y = -x - z;
  let rx = Math.round(x);
  let ry = Math.round(y);
  let rz = Math.round(z);

  const xDiff = Math.abs(rx - x);
  const yDiff = Math.abs(ry - y);
  const zDiff = Math.abs(rz - z);

  if (xDiff > yDiff && xDiff > zDiff) {
    rx = -ry - rz;
  } else if (yDiff > zDiff) {
    ry = -rx - rz;
  } else {
    rz = -rx - ry;
  }

  return { q: rx, r: rz };
}

function getNearestHexGridPoint(point, size) {
  const axial = pixelToHex(point, size);
  const rounded = hexRound(axial.q, axial.r);
  const h = (Math.sqrt(3) * size) / 2;
  const vertexOffsets = [
    { x: size, y: 0 },
    { x: size / 2, y: h },
    { x: -size / 2, y: h },
    { x: -size, y: 0 },
    { x: -size / 2, y: -h },
    { x: size / 2, y: -h },
  ];
  const neighbors = [
    { q: 0, r: 0 },
    { q: 1, r: 0 },
    { q: 1, r: -1 },
    { q: 0, r: -1 },
    { q: -1, r: 0 },
    { q: -1, r: 1 },
    { q: 0, r: 1 },
  ];

  let best = null;
  for (const dir of neighbors) {
    const center = axialToPixel(rounded.q + dir.q, rounded.r + dir.r, size);
    for (const offset of vertexOffsets) {
      const x = center.x + offset.x;
      const y = center.y + offset.y;
      const d = dist(point, { x, y });
      if (!best || d < best.distance) {
        best = { point: { x, y }, distance: d };
      }
    }
  }

  return best;
}

function getGridSnapPoint(worldPoint) {
  const settings = gridSettings.value;
  const size = settings.size;
  if (!Number.isFinite(size) || size <= 0) return null;
  if (settings.pattern === "square") {
    const x = Math.round(worldPoint.x / size) * size;
    const y = Math.round(worldPoint.y / size) * size;
    return { point: { x, y }, distance: dist(worldPoint, { x, y }) };
  }
  if (settings.pattern === "hex") {
    return getNearestHexGridPoint(worldPoint, size);
  }
  return getNearestTriGridPoint(worldPoint, size, { x: 0, y: 0 });
}

function getSnapPoint(worldPoint) {
  const snapRadius = SNAP_PX / view.scale;
  let best = null;

  for (const inter of intersections.list) {
    const d = dist(inter.point, worldPoint);
    if (d <= snapRadius) {
      if (!best || d < best.distance) {
        best = { point: inter.point, distance: d, type: "intersection" };
      }
    }
  }
  if (best) return best;

  for (const prim of state.primitives) {
    if (prim.type !== "circle" && prim.type !== "arc") continue;
    const d = dist(prim.c, worldPoint);
    if (d <= snapRadius) {
      if (!best || d < best.distance) {
        best = { point: prim.c, distance: d, type: "center", primId: prim.id };
      }
    }
  }
  if (best) return best;

  for (const prim of state.primitives) {
    if (!isLineLike(prim)) continue;
    const cp = prim.type === "segment" ? closestPointOnSegment(prim, worldPoint) : closestPointOnLine(prim, worldPoint);
    const d = dist(cp, worldPoint);
    if (d <= snapRadius) {
      if (!best || d < best.distance) {
        best = { point: cp, distance: d, type: "line", primId: prim.id };
      }
    }
  }
  if (best) return best;

  for (const prim of state.primitives) {
    if (prim.type === "circle") {
      const cp = closestPointOnCircle(prim, worldPoint);
      const d = dist(cp, worldPoint);
      if (d <= snapRadius) {
        if (!best || d < best.distance) {
          best = { point: cp, distance: d, type: "circle", primId: prim.id };
        }
      }
    }
    if (prim.type === "arc" || prim.type === "measure") {
      const cp = closestPointOnArc(prim, worldPoint);
      const d = dist(cp, worldPoint);
      if (d <= snapRadius) {
        if (!best || d < best.distance) {
          best = { point: cp, distance: d, type: "arc", primId: prim.id };
        }
      }
    }
  }

  if (best) return best;

  if (gridSettings.value.snap) {
    const grid = getGridSnapPoint(worldPoint);
    if (grid) {
      return { point: grid.point, distance: grid.distance, type: "grid" };
    }
  }

  return best;
}

function getStampSnapPoint(worldPoint) {
  const size = stampSize.value;
  const shape = stampShape.value;
  const anchors = [{ point: worldPoint, kind: "center" }];

  if (shape !== "circle" && Number.isFinite(size) && size > 0) {
    const verts = getStampVertices(worldPoint, shape, size);
    if (verts) {
      verts.forEach((vert) => anchors.push({ point: vert, kind: "vertex" }));
    }
  }

  let best = null;
  anchors.forEach((anchor) => {
    const snap = getSnapPoint(anchor.point);
    if (!snap) return;
    const offset = sub(snap.point, anchor.point);
    const center = add(worldPoint, offset);
    if (!best || snap.distance < best.distance - EPS) {
      best = { ...snap, center, anchor: anchor.kind };
    }
  });

  return best;
}

function hitTestPrimitive(worldPoint) {
  const hitRadius = HIT_PX / view.scale;
  let best = null;
  for (const prim of state.primitives) {
    if (prim.type === "line") {
      const cp = closestPointOnLine(prim, worldPoint);
      const d = dist(cp, worldPoint);
      if (d <= hitRadius) {
        if (!best || d < best.distance) best = { prim, distance: d };
      }
    }
    if (prim.type === "segment") {
      const d = distancePointToSegment(worldPoint, prim.p0, prim.p1);
      if (d <= hitRadius) {
        if (!best || d < best.distance) best = { prim, distance: d };
      }
    }
    if (prim.type === "circle") {
      const radius = dist(prim.c, prim.rp);
      const d = Math.abs(dist(prim.c, worldPoint) - radius);
      if (d <= hitRadius) {
        if (!best || d < best.distance) best = { prim, distance: d };
      }
    }
    if (prim.type === "arc" || prim.type === "measure") {
      const cp = closestPointOnArc(prim, worldPoint);
      const d = dist(cp, worldPoint);
      if (d <= hitRadius) {
        if (!best || d < best.distance) best = { prim, distance: d };
      }
    }
  }
  return best?.prim || null;
}

function hitTestCircleOrSegment(worldPoint) {
  const hitRadius = HIT_PX / view.scale;
  let best = null;
  for (const prim of state.primitives) {
    if (prim.type === "circle") {
      const radius = dist(prim.c, prim.rp);
      const d = Math.abs(dist(prim.c, worldPoint) - radius);
      if (d <= hitRadius) {
        if (!best || d < best.distance) best = { prim, distance: d };
      }
    }
    if (prim.type === "segment") {
      const d = distancePointToSegment(worldPoint, prim.p0, prim.p1);
      if (d <= hitRadius) {
        if (!best || d < best.distance) best = { prim, distance: d };
      }
    }
  }
  return best?.prim || null;
}

function isNearSpecialPoint(worldPoint) {
  const radius = SNAP_PX / view.scale;
  for (const inter of intersections.list) {
    if (dist(inter.point, worldPoint) <= radius) return true;
  }
  for (const prim of state.primitives) {
    if (prim.type === "circle") {
      if (dist(prim.c, worldPoint) <= radius) return true;
    }
    if (prim.type === "segment") {
      if (dist(prim.p0, worldPoint) <= radius) return true;
      if (dist(prim.p1, worldPoint) <= radius) return true;
    }
  }
  return false;
}

function hitTestInk(worldPoint) {
  const hitRadius = HIT_PX / view.scale;
  const bounds = getWorldBounds();
  let best = null;

  for (const seg of state.ink) {
    const prim = state.primitives.find((p) => p.id === seg.primId);
    if (!prim) continue;
    if (seg.kind === "line") {
      const a = resolveLineEndpoint(seg.a, prim, bounds);
      const b = resolveLineEndpoint(seg.b, prim, bounds);
      if (!a || !b) continue;
      const d = distancePointToSegment(worldPoint, a, b);
      if (d <= hitRadius) {
        if (!best || d < best.distance) best = { seg, distance: d };
      }
    }
    if (seg.kind === "circle") {
      const radius = dist(prim.c, prim.rp);
      if (seg.full) {
        if (isArcPrimitive(prim)) {
          const angle = normalizeAngle(Math.atan2(worldPoint.y - prim.c.y, worldPoint.x - prim.c.x));
          if (!angleInArc(angle, prim.startAngle, prim.endAngle)) continue;
        }
        const d = Math.abs(dist(prim.c, worldPoint) - radius);
        if (d <= hitRadius) {
          if (!best || d < best.distance) best = { seg, distance: d };
        }
      } else {
        const angles = resolveCircularSegmentAngles(seg, prim);
        if (!angles) continue;
        const angle = normalizeAngle(Math.atan2(worldPoint.y - prim.c.y, worldPoint.x - prim.c.x));
        if (!angleOnArc(angle, angles.aAngle, angles.bAngle, seg.ccw)) continue;
        const d = Math.abs(dist(prim.c, worldPoint) - radius);
        if (d <= hitRadius) {
          if (!best || d < best.distance) best = { seg, distance: d };
        }
      }
    }
  }

  return best?.seg || null;
}

function hitTestFill(worldPoint) {
  for (let i = state.fills.length - 1; i >= 0; i -= 1) {
    const fill = state.fills[i];
    const pixelSize = fill.pixelSize || 1;
    const localX = Math.floor((worldPoint.x - fill.origin.x) / pixelSize);
    const localY = Math.floor((worldPoint.y - fill.origin.y) / pixelSize);
    if (localX < 0 || localY < 0 || localX >= fill.width || localY >= fill.height) continue;
    const idx = localY * fill.width + localX;
    if (fill.mask[idx]) return fill;
  }
  return null;
}

function deleteInkSegment(segId) {
  state.ink = state.ink.filter((seg) => seg.id !== segId);
  state.fills = state.fills.filter((fill) => !fill.boundSegIds.includes(segId));
  scheduleRender();
}

function deleteFill(fillId) {
  state.fills = state.fills.filter((fill) => fill.id !== fillId);
  scheduleRender();
}

function addPrimitive(prim) {
  state.primitives = [...state.primitives, prim];
  recomputeIntersections();
}

function addStampAt(center) {
  const size = stampSize.value;
  if (!Number.isFinite(size) || size <= 0) return;
  const shape = stampShape.value;
  if (shape === "circle") {
    const circle = {
      id: state.nextPrimId++,
      type: "circle",
      c: center,
      rp: { x: center.x + size, y: center.y },
    };
    state.primitives = [...state.primitives, circle];
    recomputeIntersections();
    return;
  }
  const verts = getStampVertices(center, shape, size);
  if (!verts || verts.length < 2) return;
  const newPrims = [];
  for (let i = 0; i < verts.length; i += 1) {
    const p0 = verts[i];
    const p1 = verts[(i + 1) % verts.length];
    newPrims.push({
      id: state.nextPrimId++,
      type: "segment",
      p0,
      p1,
    });
  }
  state.primitives = [...state.primitives, ...newPrims];
  recomputeIntersections();
}

function inkSegmentKey(seg) {
  if (seg.kind === "line") {
    const aKey =
      seg.a?.type === "intersection"
        ? `i:${seg.a.id}`
        : seg.a?.type === "endpoint"
          ? `e:${seg.a.which}`
          : `c:${seg.a?.which}`;
    const bKey =
      seg.b?.type === "intersection"
        ? `i:${seg.b.id}`
        : seg.b?.type === "endpoint"
          ? `e:${seg.b.which}`
          : `c:${seg.b?.which}`;
    const ordered = [aKey, bKey].sort();
    return `line:${seg.primId}:${ordered[0]}:${ordered[1]}`;
  }
  if (seg.kind === "circle") {
    if (seg.full) return `circle:${seg.primId}:full`;
    return `circle:${seg.primId}:a:${circularEndpointKey(seg.a)}:b:${circularEndpointKey(seg.b)}:ccw:${seg.ccw ? 1 : 0}`;
  }
  return `seg:${seg.primId}:${seg.kind}`;
}

function addInkSegment(seg) {
  const key = inkSegmentKey(seg);
  const index = state.ink.findIndex((existing) => inkSegmentKey(existing) === key);
  if (index !== -1) {
    const existing = state.ink[index];
    const updated = {
      ...existing,
      thickness: seg.thickness ?? existing.thickness ?? 2,
    };
    state.ink = [...state.ink.slice(0, index), updated, ...state.ink.slice(index + 1)];
    scheduleRender();
    return;
  }
  state.ink = [...state.ink, seg];
  scheduleRender();
}

function addFillRegion(fill) {
  state.fills = [...state.fills, fill];
  scheduleRender();
}

function rerasterizeFills() {
  if (!state.fills.length) return;
  const currentBounds = getWorldBounds();
  const inkById = new Map(state.ink.map((seg) => [seg.id, seg]));
  const updated = state.fills.map((fill) => {
    if (!fill.seed || !fill.bounds) return fill;
    const seed = findSeedForFill(fill, currentBounds);
    if (!seed) return fill;
    const segments = fill.boundSegIds?.length
      ? fill.boundSegIds.map((id) => inkById.get(id)).filter(Boolean)
      : state.ink;
    if (!segments.length) return fill;
    const raster = rasterizeFill(seed, currentBounds, segments);
    if (!raster.ok) return fill;
    const next = {
      ...fill,
      ...raster.data,
      bounds: normalizeBounds(currentBounds),
      seed: { x: seed.x, y: seed.y },
    };
    next.canvas = buildFillCanvas(next);
    return next;
  });
  state.fills = updated;
  scheduleRender();
}

function scheduleRerasterizeFills(delay = 140) {
  if (!state.fills.length) return;
  window.clearTimeout(rerasterizeTimer);
  rerasterizeTimer = window.setTimeout(() => {
    rerasterizeTimer = null;
    rerasterizeFills();
  }, delay);
}

function buildFillCanvas(fill) {
  const off = document.createElement("canvas");
  off.width = fill.width;
  off.height = fill.height;
  const octx = off.getContext("2d");
  const image = octx.createImageData(fill.width, fill.height);
  const [r, g, b] = hexToRgb(fill.color);
  const alpha = Math.round(255 * Math.min(1, Math.max(0, fill.alpha ?? 0.65)));
  for (let i = 0; i < fill.mask.length; i += 1) {
    if (!fill.mask[i]) continue;
    const idx = i * 4;
    image.data[idx] = r;
    image.data[idx + 1] = g;
    image.data[idx + 2] = b;
    image.data[idx + 3] = alpha;
  }
  octx.putImageData(image, 0, 0);
  return off;
}

function pointInFillMask(fill, point) {
  if (!fill.mask || !fill.origin) return false;
  const pixelSize = fill.pixelSize || 1;
  const localX = Math.floor((point.x - fill.origin.x) / pixelSize);
  const localY = Math.floor((point.y - fill.origin.y) / pixelSize);
  if (localX < 0 || localY < 0 || localX >= fill.width || localY >= fill.height) return false;
  const idx = localY * fill.width + localX;
  return fill.mask[idx] === 1;
}

function findSeedForFill(fill, bounds) {
  const normalized = normalizeBounds(bounds);
  const maxX = normalized.maxX;
  const maxY = normalized.maxY;
  const minX = normalized.minX;
  const minY = normalized.minY;

  if (fill.seed) {
    if (fill.seed.x >= minX && fill.seed.x <= maxX && fill.seed.y >= minY && fill.seed.y <= maxY) {
      return fill.seed;
    }
  }

  const xs = [
    minX + (maxX - minX) * 0.25,
    (minX + maxX) / 2,
    minX + (maxX - minX) * 0.75,
  ];
  const ys = [
    minY + (maxY - minY) * 0.25,
    (minY + maxY) / 2,
    minY + (maxY - minY) * 0.75,
  ];
  for (const x of xs) {
    for (const y of ys) {
      const candidate = { x, y };
      if (pointInFillMask(fill, candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function hexToRgb(hex) {
  const clean = hex.replace("#", "");
  const value = parseInt(clean, 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return [r, g, b];
}

function inkLineSegment(line, worldPoint) {
  const list = intersections.byPrim.get(line.id) || [];
  const tClick = lineParam(line, worldPoint);
  let before = null;
  let after = null;
  list.forEach((inter) => {
    if (inter.param < tClick) before = inter;
    if (inter.param > tClick && !after) after = inter;
  });

  let a;
  let b;
  let startRef;
  let endRef;
  if (line.type === "segment") {
    startRef = { type: "endpoint", which: "start" };
    endRef = { type: "endpoint", which: "end" };
  } else {
    const bounds = getWorldBounds();
    const clip = clipLineToBounds(line, bounds);
    if (!clip) return;
    startRef = { type: "clip", which: "min" };
    endRef = { type: "clip", which: "max" };
  }

  if (!before && !after) {
    a = startRef;
    b = endRef;
  } else {
    if (before) {
      a = { type: "intersection", id: before.id };
    } else {
      a = startRef;
    }
    if (after) {
      b = { type: "intersection", id: after.id };
    } else {
      b = endRef;
    }
  }

  const seg = {
    id: state.nextInkId++,
    primId: line.id,
    kind: "line",
    a,
    b,
    thickness: inkThickness.value,
  };
  addInkSegment(seg);
}

function inkCircleSegment(circle, worldPoint) {
  const list = intersections.byPrim.get(circle.id) || [];
  const angleClick = normalizeAngle(Math.atan2(worldPoint.y - circle.c.y, worldPoint.x - circle.c.x));
  if (list.length < 2) {
    const seg = {
      id: state.nextInkId++,
      primId: circle.id,
      kind: "circle",
      full: true,
      thickness: inkThickness.value,
    };
    addInkSegment(seg);
    return;
  }
  let prev = list[list.length - 1];
  let next = list[0];
  for (let i = 0; i < list.length; i += 1) {
    if (list[i].param <= angleClick) {
      prev = list[i];
      next = list[(i + 1) % list.length];
    }
  }
  const seg = {
    id: state.nextInkId++,
    primId: circle.id,
    kind: "circle",
    full: false,
    a: { type: "intersection", id: prev.id },
    b: { type: "intersection", id: next.id },
    ccw: false,
    thickness: inkThickness.value,
  };
  addInkSegment(seg);
}

function inkArcSegment(arc, worldPoint) {
  const list = intersections.byPrim.get(arc.id) || [];
  const clickPoint = closestPointOnArc(arc, worldPoint);
  const clickAngle = normalizeAngle(Math.atan2(clickPoint.y - arc.c.y, clickPoint.x - arc.c.x));
  const startAngle = normalizeAngle(arc.startAngle);
  const endAngle = normalizeAngle(arc.endAngle);
  const span = normalizeAngle(endAngle - startAngle);
  const clickSweep = normalizeAngle(clickAngle - startAngle);

  let before = null;
  let after = null;

  list.forEach((inter) => {
    if (!angleInArc(inter.param, startAngle, endAngle)) return;
    const sweep = normalizeAngle(inter.param - startAngle);
    if (sweep > span + EPS) return;
    if (sweep < clickSweep - EPS) {
      if (!before || sweep > before.sweep) before = { id: inter.id, sweep };
    }
    if (sweep > clickSweep + EPS) {
      if (!after || sweep < after.sweep) after = { id: inter.id, sweep };
    }
  });

  const seg = {
    id: state.nextInkId++,
    primId: arc.id,
    kind: "circle",
    full: false,
    a: before ? { type: "intersection", id: before.id } : { type: "endpoint", which: "start" },
    b: after ? { type: "intersection", id: after.id } : { type: "endpoint", which: "end" },
    ccw: false,
    thickness: inkThickness.value,
  };
  addInkSegment(seg);
}

function pruneInkSegments() {
  const removed = new Set();
  const newInk = [];

  for (const seg of state.ink) {
    const prim = state.primitives.find((p) => p.id === seg.primId);
    if (!prim) {
      removed.add(seg.id);
      continue;
    }
    if (seg.kind === "line") {
      const endpoints = [seg.a, seg.b];
      let valid = true;
      for (const endpoint of endpoints) {
        if (endpoint.type === "intersection") {
          const inter = intersections.byId.get(endpoint.id);
          if (!inter) valid = false;
        }
        if (endpoint.type === "endpoint" && prim.type !== "segment") {
          valid = false;
        }
        if (endpoint.type === "clip" && prim.type !== "line") {
          valid = false;
        }
      }
      if (!valid) {
        removed.add(seg.id);
        continue;
      }
    }
    if (seg.kind === "circle") {
      if (!isCirclePrimitive(prim)) {
        removed.add(seg.id);
        continue;
      }
      if (seg.full) {
        if (prim.type === "circle") {
          const inters = intersections.byPrim.get(prim.id) || [];
          if (inters.length >= 2) {
            removed.add(seg.id);
            continue;
          }
        }
      } else {
        const endpoints = [seg.a, seg.b];
        let valid = true;
        for (const endpoint of endpoints) {
          if (!endpoint) {
            valid = false;
            continue;
          }
          if (endpoint.type === "intersection" && !intersections.byId.has(endpoint.id)) {
            valid = false;
          }
          if (endpoint.type === "endpoint") {
            if (!isArcPrimitive(prim) || (endpoint.which !== "start" && endpoint.which !== "end")) {
              valid = false;
            }
          }
          if (endpoint.type !== "intersection" && endpoint.type !== "endpoint") {
            valid = false;
          }
        }
        if (!valid) {
          removed.add(seg.id);
          continue;
        }
      }
    }
    newInk.push(seg);
  }

  state.ink = newInk;
  if (removed.size > 0) {
    state.fills = state.fills.filter((fill) => !fill.boundSegIds.some((id) => removed.has(id)));
  }
}

function deletePrimitive(id) {
  const prim = state.primitives.find((p) => p.id === id);
  if (!prim) return;
  commitHistory();
  state.primitives = state.primitives.filter((p) => p.id !== id);
  const removedInk = state.ink.filter((seg) => seg.primId === id).map((seg) => seg.id);
  state.ink = state.ink.filter((seg) => seg.primId !== id);
  recomputeIntersections();
  pruneInkSegments();
  if (removedInk.length) {
    state.fills = state.fills.filter((fill) => !fill.boundSegIds.some((segId) => removedInk.includes(segId)));
  }
  scheduleRender();
}

function normalizeBounds(bounds) {
  return {
    ...bounds,
    maxX: bounds.maxX ?? bounds.minX + bounds.width,
    maxY: bounds.maxY ?? bounds.minY + bounds.height,
    width: bounds.width ?? (bounds.maxX - bounds.minX),
    height: bounds.height ?? (bounds.maxY - bounds.minY),
  };
}

function rasterizeFill(seedWorld, boundsWorld, inkSegments = state.ink) {
  const bounds = normalizeBounds(boundsWorld);
  if (bounds.width <= EPS || bounds.height <= EPS) return { ok: false };
  let scale = getRasterScale();
  const area = bounds.width * bounds.height;
  if (area > 0) {
    const maxScaleByPixels = Math.sqrt(MAX_FILL_PIXELS / area);
    scale = Math.min(scale, maxScaleByPixels);
  }
  scale = Math.min(scale, MAX_FILL_DIM / bounds.width, MAX_FILL_DIM / bounds.height);
  if (!Number.isFinite(scale) || scale <= 0) return { ok: false };
  const pixelSize = 1 / scale;
  const originX = bounds.minX;
  const originY = bounds.minY;
  const width = Math.max(1, Math.ceil(bounds.width * scale));
  const height = Math.max(1, Math.ceil(bounds.height * scale));
  if (width <= 2 || height <= 2) return { ok: false };

  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = width;
  maskCanvas.height = height;
  const mctx = maskCanvas.getContext("2d");
  mctx.clearRect(0, 0, width, height);
  mctx.save();
  mctx.setTransform(scale, 0, 0, scale, -originX * scale, -originY * scale);
  mctx.strokeStyle = "#000";
  mctx.lineWidth = 1 / scale;
  mctx.setLineDash([]);
  mctx.lineCap = "butt";

  inkSegments.forEach((seg) => {
    const prim = state.primitives.find((p) => p.id === seg.primId);
    if (!prim) return;
    if (seg.kind === "line") {
      const a = resolveLineEndpoint(seg.a, prim, bounds);
      const b = resolveLineEndpoint(seg.b, prim, bounds);
      if (!a || !b) return;
      mctx.beginPath();
      mctx.moveTo(a.x, a.y);
      mctx.lineTo(b.x, b.y);
      mctx.stroke();
    }
    if (seg.kind === "circle") {
      const radius = dist(prim.c, prim.rp);
      if (seg.full) {
        mctx.beginPath();
        if (prim.type === "circle") {
          mctx.arc(prim.c.x, prim.c.y, radius, 0, Math.PI * 2);
        } else if (isArcPrimitive(prim)) {
          mctx.arc(prim.c.x, prim.c.y, radius, prim.startAngle, prim.endAngle, false);
        } else {
          return;
        }
        mctx.stroke();
      } else {
        const angles = resolveCircularSegmentAngles(seg, prim);
        if (!angles) return;
        mctx.beginPath();
        mctx.arc(prim.c.x, prim.c.y, radius, angles.aAngle, angles.bAngle, seg.ccw);
        mctx.stroke();
      }
    }
  });

  mctx.restore();
  const image = mctx.getImageData(0, 0, width, height);
  const wall = new Uint8Array(width * height);
  for (let i = 0; i < wall.length; i += 1) {
    if (image.data[i * 4 + 3] > 0) wall[i] = 1;
  }
  for (let x = 0; x < width; x += 1) {
    wall[x] = 1;
    wall[(height - 1) * width + x] = 1;
  }
  for (let y = 0; y < height; y += 1) {
    wall[y * width] = 1;
    wall[y * width + (width - 1)] = 1;
  }

  const startX = Math.floor((seedWorld.x - originX) * scale);
  const startY = Math.floor((seedWorld.y - originY) * scale);
  if (startX < 0 || startX >= width || startY < 0 || startY >= height) return { ok: false };
  const startIdx = startY * width + startX;
  if (wall[startIdx]) return { ok: false };

  const visited = new Uint8Array(width * height);
  const region = new Uint8Array(width * height);
  const stack = [startIdx];
  while (stack.length) {
    const idx = stack.pop();
    if (visited[idx]) continue;
    visited[idx] = 1;
    region[idx] = 1;
    const x = idx % width;
    const y = (idx - x) / width;
    const neighbors = [idx - 1, idx + 1, idx - width, idx + width];
    for (const n of neighbors) {
      if (n < 0 || n >= wall.length) continue;
      if (visited[n] || wall[n]) continue;
      stack.push(n);
    }
  }

  const expanded = new Uint8Array(region);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x;
      if (!region[idx]) continue;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const nIdx = ny * width + nx;
          if (wall[nIdx]) expanded[nIdx] = 1;
        }
      }
    }
  }

  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  let hasPixels = false;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x;
      if (!expanded[idx]) continue;
      hasPixels = true;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!hasPixels) return { ok: false };
  const cropWidth = maxX - minX + 1;
  const cropHeight = maxY - minY + 1;
  const cropMask = new Uint8Array(cropWidth * cropHeight);
  for (let y = 0; y < cropHeight; y += 1) {
    for (let x = 0; x < cropWidth; x += 1) {
      const srcIdx = (minY + y) * width + (minX + x);
      const dstIdx = y * cropWidth + x;
      cropMask[dstIdx] = expanded[srcIdx];
    }
  }

  return {
    ok: true,
    data: {
      origin: { x: originX + minX * pixelSize, y: originY + minY * pixelSize },
      width: cropWidth,
      height: cropHeight,
      mask: cropMask,
      pixelSize,
    },
  };
}

function performFill(worldPoint) {
  if (!state.ink.length) {
    setStatus("Ink boundaries required for fill.");
    return false;
  }

  const bounds = getWorldBounds();
  const raster = rasterizeFill(worldPoint, bounds, state.ink);
  if (!raster.ok) {
    return false;
  }

  const fill = {
    id: state.nextFillId,
    seed: { x: worldPoint.x, y: worldPoint.y },
    bounds: normalizeBounds(bounds),
    color: fillColor.value,
    alpha: fillAlpha.value,
    boundSegIds: state.ink.map((seg) => seg.id),
    ...raster.data,
  };
  fill.canvas = buildFillCanvas(fill);
  commitHistory();
  state.nextFillId += 1;
  addFillRegion(fill);
  return true;
}

function getPointerScreenPosition(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function getTouchGesturePoints() {
  if (!touchGesture) return null;
  const first = activeTouchPoints.get(touchGesture.idA);
  const second = activeTouchPoints.get(touchGesture.idB);
  if (!first || !second) return null;
  return [first, second];
}

function getActionSnap(toolId, worldPoint) {
  return toolId === "stamp" ? getStampSnapPoint(worldPoint) : getSnapPoint(worldPoint);
}

function getActionTarget(toolId, worldPoint) {
  const snap = getActionSnap(toolId, worldPoint);
  return {
    snap,
    target: snap?.center || snap?.point || worldPoint,
  };
}

function isTouchDragConstructionTool(toolId) {
  return (
    toolId === "straightedge" ||
    toolId === "segment" ||
    toolId === "compass" ||
    toolId === "arc" ||
    toolId === "copy"
  );
}

function clearTouchDrawGesture(gesture) {
  if (gesture?.kind === "arc-start-end") {
    toolState = { step: 0, center: gesture.center, radius: gesture.radius };
  } else {
    toolState = { step: 0 };
  }
  hoverSnap = null;
  bumpToolHelpTick();
  scheduleRender();
}

function cancelTouchDrawGesture() {
  if (!touchDrawGesture) return false;
  const gesture = touchDrawGesture;
  touchDrawGesture = null;
  clearTouchDrawGesture(gesture);
  return true;
}

function beginTouchDrawGesture(pointerId) {
  const toolId = tool.value;
  if (!isTouchDragConstructionTool(toolId)) return false;

  const { snap, target } = getActionTarget(toolId, pointerWorld);

  if (toolId === "straightedge" || toolId === "segment") {
    touchDrawGesture = {
      id: pointerId,
      kind: toolId,
      toolId,
      start: target,
    };
    toolState = { step: 0, anchor: target };
  } else if (toolId === "compass") {
    touchDrawGesture = {
      id: pointerId,
      kind: "compass",
      toolId,
      center: target,
    };
    toolState = { step: 0, center: target };
  } else if (toolId === "arc") {
    const arcCenter = toolState.center;
    const arcRadius = Number.isFinite(toolState.radius) ? toolState.radius : null;
    if (arcCenter && arcRadius && arcRadius > 0) {
      const start = projectToRadius(arcCenter, target, arcRadius).point;
      touchDrawGesture = {
        id: pointerId,
        kind: "arc-start-end",
        toolId,
        center: arcCenter,
        radius: arcRadius,
        start,
      };
      toolState = { step: 0, center: arcCenter, radius: arcRadius, start };
    } else {
      touchDrawGesture = {
        id: pointerId,
        kind: "arc-radius",
        toolId,
        center: target,
      };
      toolState = { step: 0, center: target };
    }
  } else if (toolId === "copy") {
    touchDrawGesture = {
      id: pointerId,
      kind: "copy",
      toolId,
      start: target,
    };
    toolState = { step: 0, p0: target };
  }

  touchTapCandidate = null;
  hoverSnap = snap;
  bumpToolHelpTick();
  scheduleRender();
  return true;
}

function finalizeTouchDrawGesture(pointerId, worldPoint, canceled = false) {
  if (!touchDrawGesture || touchDrawGesture.id !== pointerId) return false;

  const gesture = touchDrawGesture;
  touchDrawGesture = null;

  if (canceled) {
    clearTouchDrawGesture(gesture);
    return true;
  }

  const { target } = getActionTarget(gesture.toolId, worldPoint);
  hoverSnap = null;

  if (gesture.kind === "straightedge") {
    if (dist(gesture.start, target) < 1) {
      setStatus("Straightedge needs two distinct points.");
      toolState = { step: 0 };
      bumpToolHelpTick();
      scheduleRender();
      return true;
    }
    commitHistory();
    addPrimitive({
      id: state.nextPrimId++,
      type: "line",
      p0: gesture.start,
      p1: target,
    });
    toolState = { step: 0 };
    bumpToolHelpTick();
    scheduleRender();
    return true;
  }

  if (gesture.kind === "segment") {
    if (dist(gesture.start, target) < 1) {
      setStatus("Line segment needs two distinct points.");
      toolState = { step: 0 };
      bumpToolHelpTick();
      scheduleRender();
      return true;
    }
    commitHistory();
    addPrimitive({
      id: state.nextPrimId++,
      type: "segment",
      p0: gesture.start,
      p1: target,
    });
    toolState = { step: 0 };
    bumpToolHelpTick();
    scheduleRender();
    return true;
  }

  if (gesture.kind === "compass") {
    if (dist(gesture.center, target) < 1) {
      setStatus("Compass radius too small.");
      toolState = { step: 0 };
      bumpToolHelpTick();
      scheduleRender();
      return true;
    }
    commitHistory();
    addPrimitive({
      id: state.nextPrimId++,
      type: "circle",
      c: gesture.center,
      rp: target,
    });
    toolState = { step: 0 };
    bumpToolHelpTick();
    scheduleRender();
    return true;
  }

  if (gesture.kind === "arc-radius") {
    const radius = dist(gesture.center, target);
    if (radius < 1) {
      setStatus("Arc radius too small.");
      toolState = { step: 0 };
      bumpToolHelpTick();
      scheduleRender();
      return true;
    }
    toolState = { step: 0, center: gesture.center, radius };
    bumpToolHelpTick();
    scheduleRender();
    return true;
  }

  if (gesture.kind === "arc-start-end") {
    const radius = gesture.radius ?? dist(gesture.center, gesture.start);
    if (radius < 1) {
      setStatus("Arc radius too small.");
      toolState = { step: 0 };
      bumpToolHelpTick();
      scheduleRender();
      return true;
    }
    const angles = computeArcAngles(gesture.center, gesture.start, target, radius);
    commitHistory();
    addPrimitive({
      id: state.nextPrimId++,
      type: "arc",
      c: gesture.center,
      rp: angles.startPoint,
      startAngle: angles.startAngle,
      endAngle: angles.endAngle,
    });
    toolState = { step: 0 };
    bumpToolHelpTick();
    scheduleRender();
    return true;
  }

  if (gesture.kind === "copy") {
    commitHistory();
    const d = dist(gesture.start, target);
    measureDistance.value = d;
    toolState = { step: 0 };
    setStatus("Measure copied.");
    bumpToolHelpTick();
    scheduleRender();
    return true;
  }

  toolState = { step: 0 };
  bumpToolHelpTick();
  scheduleRender();
  return true;
}

function beginTouchGesture() {
  const points = Array.from(activeTouchPoints.values());
  if (points.length < 2) return false;
  cancelTouchDrawGesture();
  const [a, b] = points;
  const midpoint = {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  };
  touchGesture = {
    idA: a.id,
    idB: b.id,
    startScale: view.scale,
    startDistance: Math.max(1, dist(a, b)),
    anchorWorld: screenToWorld(midpoint),
  };
  touchTapCandidate = null;
  hoverSnap = null;
  return true;
}

function updateTouchGesture() {
  const points = getTouchGesturePoints();
  if (!points || !touchGesture) return false;
  const [a, b] = points;
  const midpoint = {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  };
  const distance = Math.max(1, dist(a, b));
  const scaleFactor = distance / touchGesture.startDistance;
  view.scale = clampScale(touchGesture.startScale * scaleFactor);
  view.panX = midpoint.x / view.scale - touchGesture.anchorWorld.x;
  view.panY = midpoint.y / view.scale - touchGesture.anchorWorld.y;
  zoomValue.value = view.scale;
  panDirty = true;
  scheduleRender();
  return true;
}

function handlePrimaryPointerAction() {
  if (tool.value === "erase") {
    const fillHit = hitTestFill(pointerWorld);
    if (fillHit) {
      commitHistory();
      deleteFill(fillHit.id);
      return;
    }
    const inkHit = hitTestInk(pointerWorld);
    if (inkHit) {
      commitHistory();
      deleteInkSegment(inkHit.id);
      return;
    }
    const primHit = hitTestPrimitive(pointerWorld);
    if (primHit) {
      deletePrimitive(primHit.id);
    }
    return;
  }

  const { target } = getActionTarget(tool.value, pointerWorld);

  if (tool.value === "compass") {
    if (!toolState.center) {
      toolState.center = target;
    } else {
      if (dist(toolState.center, target) < 1) {
        setStatus("Compass radius too small.");
        toolState = { step: 0 };
        bumpToolHelpTick();
        return;
      }
      commitHistory();
      const circle = {
        id: state.nextPrimId++,
        type: "circle",
        c: toolState.center,
        rp: target,
      };
      addPrimitive(circle);
      toolState = { step: 0 };
    }
  }

  if (tool.value === "straightedge") {
    if (!toolState.anchor) {
      toolState.anchor = target;
    } else {
      if (dist(toolState.anchor, target) < 1) {
        setStatus("Straightedge needs two distinct points.");
        toolState = { step: 0 };
        bumpToolHelpTick();
        return;
      }
      commitHistory();
      const line = {
        id: state.nextPrimId++,
        type: "line",
        p0: toolState.anchor,
        p1: target,
      };
      addPrimitive(line);
      toolState = { step: 0 };
    }
  }

  if (tool.value === "segment") {
    if (!toolState.anchor) {
      toolState.anchor = target;
    } else {
      if (dist(toolState.anchor, target) < 1) {
        setStatus("Line segment needs two distinct points.");
        toolState = { step: 0 };
        bumpToolHelpTick();
        return;
      }
      commitHistory();
      const segment = {
        id: state.nextPrimId++,
        type: "segment",
        p0: toolState.anchor,
        p1: target,
      };
      addPrimitive(segment);
      toolState = { step: 0 };
    }
  }

  if (tool.value === "arc") {
    if (!toolState.center) {
      toolState.center = target;
    } else if (!toolState.start) {
      const radius = dist(toolState.center, target);
      if (radius < 1) {
        setStatus("Arc radius too small.");
        toolState = { step: 0 };
        bumpToolHelpTick();
        return;
      }
      toolState.start = target;
      toolState.radius = radius;
    } else {
      const radius = toolState.radius ?? dist(toolState.center, toolState.start);
      if (radius < 1) {
        setStatus("Arc radius too small.");
        toolState = { step: 0 };
        bumpToolHelpTick();
        return;
      }
      const angles = computeArcAngles(toolState.center, toolState.start, target, radius);
      commitHistory();
      const arc = {
        id: state.nextPrimId++,
        type: "arc",
        c: toolState.center,
        rp: angles.startPoint,
        startAngle: angles.startAngle,
        endAngle: angles.endAngle,
      };
      addPrimitive(arc);
      toolState = { step: 0 };
    }
  }

  if (tool.value === "stamp") {
    const size = stampSize.value;
    if (!Number.isFinite(size) || size <= 0) return;
    commitHistory();
    addStampAt(target);
    toolState = { step: 0 };
  }

  if (tool.value === "ink") {
    const hit = hitTestPrimitive(pointerWorld);
    if (!hit) return;
    if (hit.type !== "line" && hit.type !== "segment" && hit.type !== "circle" && hit.type !== "arc") {
      return;
    }
    commitHistory();
    if (hit.type === "line" || hit.type === "segment") {
      inkLineSegment(hit, pointerWorld);
    }
    if (hit.type === "circle") {
      inkCircleSegment(hit, pointerWorld);
    }
    if (hit.type === "arc") {
      inkArcSegment(hit, pointerWorld);
    }
  }

  if (tool.value === "fill") {
    performFill(pointerWorld);
  }

  if (tool.value === "copy") {
    const hit = isNearSpecialPoint(pointerWorld) ? null : hitTestCircleOrSegment(pointerWorld);
    if (hit?.type === "circle") {
      commitHistory();
      measureDistance.value = dist(hit.c, hit.rp);
      toolState = { step: 0 };
      setStatus("Circle radius copied.");
      bumpToolHelpTick();
      return;
    }
    if (hit?.type === "segment") {
      commitHistory();
      measureDistance.value = dist(hit.p0, hit.p1);
      toolState = { step: 0 };
      setStatus("Segment length copied.");
      bumpToolHelpTick();
      return;
    }
    if (!toolState.p0) {
      toolState.p0 = target;
    } else {
      commitHistory();
      const d = dist(toolState.p0, target);
      measureDistance.value = d;
      toolState = { step: 0 };
      setStatus("Measure copied.");
    }
  }

  if (tool.value === "paste") {
    if (!measureDistance.value) {
      setStatus("Copy a measure first (tool 8).");
      return;
    }
    if (!toolState.center) {
      toolState.center = target;
    } else {
      commitHistory();
      const angle = Math.atan2(target.y - toolState.center.y, target.x - toolState.center.x);
      const startAngle = normalizeAngle(angle - ARC_SPAN / 2);
      const endAngle = normalizeAngle(angle + ARC_SPAN / 2);
      const measure = {
        id: state.nextPrimId++,
        type: "measure",
        c: toolState.center,
        rp: {
          x: toolState.center.x + Math.cos(angle) * measureDistance.value,
          y: toolState.center.y + Math.sin(angle) * measureDistance.value,
        },
        startAngle,
        endAngle,
      };
      addPrimitive(measure);
      toolState = { step: 0 };
    }
  }

  bumpToolHelpTick();
  scheduleRender();
}

function handlePointerMove(event) {
  const screen = getPointerScreenPosition(event);
  pointerWorld = screenToWorld(screen);

  if (event.pointerType === "touch") {
    if (!activeTouchPoints.has(event.pointerId)) return;
    activeTouchPoints.set(event.pointerId, {
      id: event.pointerId,
      x: screen.x,
      y: screen.y,
    });
    if (touchTapCandidate && touchTapCandidate.id === event.pointerId) {
      const traveled = dist(screen, touchTapCandidate.start);
      if (traveled > TOUCH_TAP_SLOP_PX) {
        touchTapCandidate.moved = true;
      }
    }
    if (touchGesture) {
      updateTouchGesture();
      return;
    }
    if (activeTouchPoints.size >= 2) {
      beginTouchGesture();
      updateTouchGesture();
      return;
    }
    if (touchDrawGesture && touchDrawGesture.id === event.pointerId) {
      hoverSnap = getActionSnap(touchDrawGesture.toolId, pointerWorld);
      scheduleRender();
      return;
    }
    return;
  }

  if (isPanning) {
    const dx = screen.x - pointerStart.x;
    const dy = screen.y - pointerStart.y;
    view.panX = panStart.x + dx / view.scale;
    view.panY = panStart.y + dy / view.scale;
    panDirty = true;
    scheduleRender();
    return;
  }

  if (["compass", "straightedge", "segment", "arc", "stamp", "copy", "paste"].includes(tool.value)) {
    hoverSnap = getActionSnap(tool.value, pointerWorld);
  } else {
    hoverSnap = null;
  }

  scheduleRender();
}

function handlePointerDown(event) {
  canvas.setPointerCapture(event.pointerId);
  const screen = getPointerScreenPosition(event);
  pointerWorld = screenToWorld(screen);

  if (event.pointerType === "touch") {
    event.preventDefault();
    activeTouchPoints.set(event.pointerId, {
      id: event.pointerId,
      x: screen.x,
      y: screen.y,
    });
    if (activeTouchPoints.size >= 2) {
      beginTouchGesture();
      updateTouchGesture();
      return;
    }
    if (beginTouchDrawGesture(event.pointerId)) {
      return;
    }
    if (!touchGesture && activeTouchPoints.size === 1) {
      touchTapCandidate = {
        id: event.pointerId,
        start: { x: screen.x, y: screen.y },
        moved: false,
      };
    } else {
      touchTapCandidate = null;
    }
    return;
  }

  const panningIntent = spaceDown || event.button === 1;
  if (panningIntent) {
    isPanning = true;
    panDirty = false;
    panStart = { x: view.panX, y: view.panY };
    pointerStart = { x: screen.x, y: screen.y };
    return;
  }

  handlePrimaryPointerAction();
}

function handlePointerUp(event) {
  if (event.pointerType === "touch") {
    const screen = getPointerScreenPosition(event);
    const pointerScreen = activeTouchPoints.get(event.pointerId) || {
      id: event.pointerId,
      x: screen.x,
      y: screen.y,
    };
    const canceled = event.type === "pointercancel";
    const wasTouchGesture = Boolean(touchGesture);
    activeTouchPoints.delete(event.pointerId);
    if (touchGesture) {
      if (!getTouchGesturePoints()) {
        touchGesture = null;
        touchTapCandidate = null;
        if (panDirty) {
          panDirty = false;
          scheduleRerasterizeFills();
        }
      } else {
        updateTouchGesture();
      }
    }
    if (!wasTouchGesture && finalizeTouchDrawGesture(event.pointerId, screenToWorld(pointerScreen), canceled)) {
      if (touchTapCandidate && touchTapCandidate.id === event.pointerId) {
        touchTapCandidate = null;
      }
      return;
    }
    if (
      !canceled &&
      !wasTouchGesture &&
      touchTapCandidate &&
      touchTapCandidate.id === event.pointerId &&
      !touchTapCandidate.moved
    ) {
      pointerWorld = screenToWorld(pointerScreen);
      handlePrimaryPointerAction();
    }
    if (touchTapCandidate && touchTapCandidate.id === event.pointerId) {
      touchTapCandidate = null;
    }
    return;
  }

  if (isPanning) {
    isPanning = false;
    if (panDirty) {
      panDirty = false;
      scheduleRerasterizeFills();
    }
  }
}

function handleWheel(event) {
  event.preventDefault();
  const screen = getPointerScreenPosition(event);
  const zoomFactor = Math.exp(-event.deltaY * 0.0015);
  zoomBy(zoomFactor, screen);
}

function handleKeyDown(event) {
  const key = event.key.toLowerCase();
  const withCommand = event.metaKey || event.ctrlKey;
  if (withCommand && !event.altKey) {
    if (key === "s") {
      saveDrawingJson();
      event.preventDefault();
      return;
    }
    if (key === "o") {
      loadDrawingJson();
      event.preventDefault();
      return;
    }
  }
  if (showSaveDialog.value && key === "escape") {
    showSaveDialog.value = false;
    event.preventDefault();
    return;
  }
  if (event.target) {
    const tag = event.target.tagName;
    if (tag === "TEXTAREA") return;
    if (tag === "INPUT") {
      const type = (event.target.type || "").toLowerCase();
      const allow = ["checkbox", "range", "color", "button"].includes(type);
      if (!allow) return;
    }
  }
  if (event.code === "Space") {
    spaceDown = true;
    event.preventDefault();
    return;
  }
  if (key === "escape") {
    toolState = { step: 0 };
    hoverSnap = null;
    bumpToolHelpTick();
    scheduleRender();
    return;
  }
  const toolKey = toolDefs.find((def) => def.key.toLowerCase() === key);
  if (toolKey) {
    setTool(toolKey.id);
    return;
  }
  if (key === "z") {
    undo();
  }
  if (key === "y") {
    redo();
  }
  if (key === "x") {
    clearAll();
  }
  if ((key === "0" && !event.shiftKey) || event.code === "Numpad0") {
    resetZoom();
    event.preventDefault();
  }
  if (key === "+" || key === "=" || event.code === "NumpadAdd") {
    zoomBy(1.1);
    event.preventDefault();
  }
  if (key === "-" || event.code === "NumpadSubtract") {
    zoomBy(1 / 1.1);
    event.preventDefault();
  }
}

function handleKeyUp(event) {
  if (event.code === "Space") {
    spaceDown = false;
  }
}

canvas.addEventListener("pointerdown", handlePointerDown);
canvas.addEventListener("pointermove", handlePointerMove);
canvas.addEventListener("pointerup", handlePointerUp);
canvas.addEventListener("pointercancel", handlePointerUp);
canvas.addEventListener("wheel", handleWheel, { passive: false });
window.addEventListener("pointermove", handlePaletteDrag);
window.addEventListener("pointerup", stopPaletteDrag);
window.addEventListener("pointercancel", stopPaletteDrag);
window.addEventListener("pointermove", handleTouchMenuPointerMove, { passive: false });
window.addEventListener("pointerup", handleTouchMenuPointerEnd, { passive: false });
window.addEventListener("pointercancel", handleTouchMenuPointerEnd, { passive: false });
window.addEventListener("keydown", handleKeyDown);
window.addEventListener("keyup", handleKeyUp);
window.addEventListener("resize", scheduleRender);

function loadShareFromUrl() {
  const url = new URL(window.location.href);
  const payload = url.searchParams.get("share");
  if (!payload) return false;
  try {
    const json = decodeBase64Url(payload);
    const data = JSON.parse(json);
    restoreShareState(data);
  } catch (error) {
    console.warn("Invalid share payload", error);
    setStatus("Invalid share URL.");
  }
  url.searchParams.delete("share");
  window.history.replaceState({}, "", url.toString());
  return true;
}

function init() {
  const loaded = loadShareFromUrl();
  if (!loaded) {
    recomputeIntersections();
  }
  zoomValue.value = view.scale;
  scheduleRender();
}

init();

effect(() => {
  tool.value;
  scheduleRender();
});

effect(() => {
  fillColor.value;
  scheduleRender();
});
