import type { PluginButtonProps, PluginFrontendContext, PluginSessionViewInput, PluginWidgetHandle } from "learnharness-plugin-api";
import { captureBackground } from "./capture.ts";
import { frame } from "./abort.ts";
import { PEN, ERASER, HAND, UNDO } from "./icons.ts";
import { referenceFor, mountReference } from "./reference.ts";
import { referenceBounds, viewOrigin } from "./geometry.ts";
import { paintInk, paintSegment, touchesStroke, visibleStrokes, type Point, type Stroke } from "./strokes.ts";
import type { SessionSheet, Sheets } from "./state.ts";
import { appPalette } from "./theme.ts";

export interface MountedSheet {
  flush(): void;
  dispose(): void;
  canUseEditingShortcuts(): boolean;
  canUndo(): boolean;
  undo(): void;
  togglePenEraser(): void;
  selectHand(): void;
}
export function mountSheet(container: HTMLElement, ctx: PluginFrontendContext, sheets: Sheets, state: SessionSheet,
  input: PluginSessionViewInput, signal: AbortSignal): MountedSheet {
  const root = document.createElement("div"); root.className = "drawing-pad-root";
  const toolbar = document.createElement("div"); toolbar.className = "drawing-pad-tools";
  toolbar.setAttribute("role", "group");
  const viewport = document.createElement("div"); viewport.className = "drawing-pad-viewport";
  viewport.tabIndex = -1; viewport.dataset.pluginInitialFocus = "";
  viewport.setAttribute("role", "group"); viewport.setAttribute("aria-label", "Drawing sheet");
  const paper = document.createElement("div"); paper.className = "drawing-pad-paper";
  const background = document.createElement("img"); background.alt = "Frozen question reference";
  background.className = "drawing-pad-background"; background.draggable = false;
  const canvas = document.createElement("canvas"); canvas.className = "drawing-pad-ink";
  canvas.setAttribute("aria-label", "Draw with a mouse or pen; pan with Hand or a right mouse drag");
  const liveCtx = canvas.getContext("2d", { willReadFrequently: true });
  const status = document.createElement("div"); status.className = "drawing-pad-status"; status.setAttribute("role", "status");
  paper.append(background, canvas); viewport.append(paper, status); root.append(toolbar, viewport); container.append(root);
  const buttons: PluginWidgetHandle<PluginButtonProps>[] = [];
  let disposed = false, preparing = !state.draft, active: Stroke | undefined, activeDraftId: number | undefined;
  let pointerId: number | undefined;
  let panDrag: { x: number; y: number; pan: SessionSheet["pan"]; rightButton: boolean } | undefined;
  let reference: HTMLElement | undefined;
  let referenceMount: ReturnType<typeof mountReference> | undefined;
  let failure: string | undefined;
  let canvasRect: DOMRect | undefined;
  let eraserRemaining: Stroke[] | undefined;
  let painted: {
    draftId: number; revision: number; panX: number; panY: number;
    width: number; height: number; pixelRatio: number; color: string;
    activeStroke?: Stroke; activePoints: number;
  } | undefined;
  const toolButton = (label: string, onClick: () => void, icon?: string) => {
    const target = document.createElement("span"); toolbar.append(target);
    let prevVariant: PluginButtonProps["variant"] = "outline";
    let prevDisabled: boolean | undefined;
    const handle = ctx.ui.mountButton(target, { label, title: label, onClick, variant: "outline", size: icon ? "icon-sm" : "sm",
      ...(icon ? { icon, iconOnly: true } : {}) }, { signal });
    buttons.push(handle);
    return {
      update(next: { variant?: PluginButtonProps["variant"]; disabled?: boolean }) {
        if ((next.variant === undefined || next.variant === prevVariant) && next.disabled === prevDisabled) return;
        if (next.variant !== undefined) prevVariant = next.variant;
        prevDisabled = next.disabled;
        handle.update(next);
      },
    };
  };
  const pen = toolButton("Pen", () => sheets.setTool(state, "pen"), PEN);
  const eraser = toolButton("Eraser", () => sheets.setTool(state, "eraser"), ERASER);
  const hand = toolButton("Hand", () => sheets.setTool(state, "hand"), HAND);
  const commitHistory = (strokes: Stroke[]) => sheets.update(state, strokes);
  const editable = () => !disposed && !signal.aborted && !preparing && !failure && !!state.draft && pointerId === undefined;
  const canUseEditingShortcuts = () => {
    if (!editable()) return false;
    const focused = document.activeElement;
    return focused instanceof HTMLElement && root.contains(focused) && !focused.isContentEditable &&
      !focused.closest('input,textarea,select,[role="textbox"],[role="combobox"]');
  };
  const canUndo = () => editable() && !!state.draft?.strokes.length;
  const undoHistory = () => { if (canUndo()) commitHistory(state.draft!.strokes.slice(0, -1)); };
  const togglePenEraser = () => { if (editable()) sheets.setTool(state, state.tool === "pen" ? "eraser" : "pen"); };
  const selectHand = () => { if (editable()) sheets.setTool(state, "hand"); };
  const undo = toolButton("Undo", undoHistory, UNDO);
  const clear = toolButton("Clear", () => { if (pointerId === undefined && state.draft) commitHistory([]); });
  let prevToolbarLabel = "", prevCursor = "", prevStatusHidden: boolean | undefined, prevStatusRole = "", prevStatusText = "", prevPaperHidden: boolean | undefined;
  const syncControls = () => {
    if (disposed) return;
    const draft = state.draft;
    const toolbarLabel = `Drawing tools. ${state.tool === "pen" ? "Pen" : state.tool === "eraser" ? "Eraser" : "Hand"} selected.`;
    if (toolbarLabel !== prevToolbarLabel) { prevToolbarLabel = toolbarLabel; toolbar.setAttribute("aria-label", toolbarLabel); }
    const toolDisabled = preparing || !!failure;
    pen.update({ variant: state.tool === "pen" ? "secondary" : "outline", disabled: toolDisabled });
    eraser.update({ variant: state.tool === "eraser" ? "secondary" : "outline", disabled: toolDisabled });
    hand.update({ variant: state.tool === "hand" ? "secondary" : "outline", disabled: toolDisabled });
    const actionDisabled = toolDisabled || pointerId !== undefined || !draft?.strokes.length;
    undo.update({ disabled: actionDisabled });
    clear.update({ disabled: actionDisabled });
    const cursor = panDrag ? "grabbing" : state.tool === "hand" ? "grab" : "default";
    if (cursor !== prevCursor) { prevCursor = cursor; canvas.style.cursor = cursor; }
    const statusHidden = !preparing && !failure;
    if (statusHidden !== prevStatusHidden) { prevStatusHidden = statusHidden; status.hidden = statusHidden; }
    const statusRole = failure ? "alert" : "status";
    if (statusRole !== prevStatusRole) { prevStatusRole = statusRole; status.setAttribute("role", statusRole); }
    const statusText = failure ?? (preparing ? "Preparing drawing sheet…" : "");
    if (statusText !== prevStatusText) { prevStatusText = statusText; status.textContent = statusText; }
    const paperHidden = !draft || preparing || !!failure;
    if (paperHidden !== prevPaperHidden) { prevPaperHidden = paperHidden; paper.hidden = paperHidden; }
  };
  const render = () => {
    if (disposed) return;
    const draft = state.draft;
    const width = draft ? viewport.clientWidth : 0, height = draft ? viewport.clientHeight : 0;
    syncControls();
    if (!draft) { painted = undefined; return; }
    if (!width || !height) return;
    // Keep the previous raster and its ink readable until the new palette
    // is ready to replace them together.
    if (paper.style.backgroundColor !== draft.backgroundColor) paper.style.backgroundColor = draft.backgroundColor;
    const origin = viewOrigin(width, height, state.pan, draft.height), bounds = referenceBounds(draft.width, draft.height);
    if (background.hidden !== !draft.background) background.hidden = !draft.background;
    if (draft.background && background.getAttribute("src") !== draft.background) background.src = draft.background;
    const bgW = `${draft.width}px`, bgH = `${draft.height}px`, bgL = `${origin.x + bounds.x}px`, bgT = `${origin.y + bounds.y}px`;
    if (background.style.width !== bgW) background.style.width = bgW;
    if (background.style.height !== bgH) background.style.height = bgH;
    if (background.style.left !== bgL) background.style.left = bgL;
    if (background.style.top !== bgT) background.style.top = bgT;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const pixelsWide = Math.max(1, Math.round(width * pixelRatio)), pixelsHigh = Math.max(1, Math.round(height * pixelRatio));
    if (canvas.width !== pixelsWide) canvas.width = pixelsWide;
    if (canvas.height !== pixelsHigh) canvas.height = pixelsHigh;
    const currentActive = active && activeDraftId === draft.id ? active : undefined;
    const canReuseIncremental = painted &&
      painted.draftId === draft.id &&
      painted.panX === state.pan.x &&
      painted.panY === state.pan.y &&
      painted.width === width &&
      painted.height === height &&
      painted.pixelRatio === pixelRatio &&
      painted.color === draft.color && (
        (!currentActive && !painted.activeStroke && painted.revision === draft.revision) ||
        (!currentActive && painted.activeStroke && draft.revision === painted.revision + 1 &&
          draft.strokes.at(-1) === painted.activeStroke && painted.activePoints === painted.activeStroke.points.length) ||
        (currentActive && painted.revision === draft.revision &&
          painted.activeStroke === currentActive && painted.activePoints === currentActive.points.length)
      );
    if (canReuseIncremental && painted) {
      painted.revision = draft.revision;
      if (!currentActive) { painted.activeStroke = undefined; painted.activePoints = 0; }
      return;
    }
    const history = currentActive ? [...draft.strokes, currentActive] : draft.strokes;
    paintInk(canvas, width, height, history, draft.color, origin);
    painted = {
      draftId: draft.id, revision: draft.revision, panX: state.pan.x, panY: state.pan.y,
      width, height, pixelRatio, color: draft.color,
      activeStroke: currentActive, activePoints: currentActive?.points.length ?? 0,
    };
  };
  const getRect = (): DOMRect => canvasRect ?? (canvasRect = canvas.getBoundingClientRect());
  const pointFrom = (event: PointerEvent, rect: DOMRect, origin: { x: number; y: number }): Point => ({
    x: event.clientX - rect.left - origin.x,
    y: event.clientY - rect.top - origin.y,
    pressure: event.pointerType === "pen" && event.pressure > 0 ? event.pressure : 0.5,
  });
  const flush = () => {
    const stroke = active, id = activeDraftId;
    active = undefined; activeDraftId = undefined; panDrag = undefined;
    const draft = state.draft;
    if (stroke && draft && draft.id === id) commitHistory([...draft.strokes, stroke]);
  };
  const start = (event: PointerEvent, rect?: DOMRect, origin?: { x: number; y: number }) => {
    const draft = state.draft;
    if (!draft || state.tool === "hand") return;
    const r = rect ?? getRect();
    const o = origin ?? viewOrigin(r.width, r.height, state.pan, draft.height);
    const p0 = pointFrom(event, r, o);
    const tool = (event.buttons & 32) !== 0 ? "eraser" : state.tool;
    activeDraftId = draft.id;
    active = { tool, points: [p0] };
    if (tool === "pen") {
      eraserRemaining = undefined;
      if (liveCtx && painted && !painted.activeStroke &&
        painted.draftId === draft.id && painted.revision === draft.revision &&
        painted.panX === state.pan.x && painted.panY === state.pan.y &&
        Math.abs(painted.width - r.width) <= 1 && Math.abs(painted.height - r.height) <= 1 &&
        painted.color === draft.color) {
        const po = painted.width === r.width && painted.height === r.height ? o : viewOrigin(painted.width, painted.height, state.pan, draft.height);
        const sx = canvas.width / painted.width, sy = canvas.height / painted.height;
        liveCtx.setTransform(sx, 0, 0, sy, po.x * sx, po.y * sy);
        paintSegment(liveCtx, p0, p0, draft.color);
        painted.activeStroke = active;
        painted.activePoints = 1;
        syncControls();
        return;
      }
    } else {
      eraserRemaining = visibleStrokes(draft.strokes);
      const nextRemaining = eraserRemaining.filter(stroke => !touchesStroke(stroke, active!));
      if (nextRemaining.length === eraserRemaining.length) {
        syncControls();
        return;
      }
      eraserRemaining = nextRemaining;
    }
    render();
  };
  const down = (event: PointerEvent) => {
    const rightButton = event.pointerType === "mouse" && event.button === 2;
    if (preparing || failure || !state.draft || pointerId !== undefined || event.pointerType === "touch" ||
      (event.pointerType !== "pen" && event.button !== 0 && !rightButton)) return;
    event.preventDefault();
    const rect = canvasRect = canvas.getBoundingClientRect();
    if (document.activeElement !== viewport) viewport.focus({ preventScroll: true });
    pointerId = event.pointerId; canvas.setPointerCapture(event.pointerId);
    if (rightButton || state.tool === "hand") {
      panDrag = { x: event.clientX, y: event.clientY, pan: state.pan, rightButton }; render();
    }
    else if (event.pointerType !== "pen" || event.pressure > 0) start(event, rect);
  };
  const move = (event: PointerEvent) => {
    const draft = state.draft;
    if (preparing || failure || !draft || pointerId !== event.pointerId) return;
    if (panDrag) {
      // Releasing Right while another mouse button is held emits pointermove,
      // not pointerup. End this gesture before any unheld movement can pan.
      if (panDrag.rightButton && (event.buttons & 2) === 0) { finish(event); return; }
      if (event.pointerType !== "pen" || event.pressure > 0) sheets.setPan(state,
        { x: panDrag.pan.x + event.clientX - panDrag.x, y: panDrag.pan.y + event.clientY - panDrag.y });
      return;
    }
    if (state.tool === "hand") return;
    const rect = getRect(), origin = viewOrigin(rect.width, rect.height, state.pan, draft.height);
    if (liveCtx && painted) {
      const po = painted.width === rect.width && painted.height === rect.height ? origin : viewOrigin(painted.width, painted.height, state.pan, draft.height);
      const sx = canvas.width / painted.width, sy = canvas.height / painted.height;
      liveCtx.setTransform(sx, 0, 0, sy, po.x * sx, po.y * sy);
    }
    const coalesced = event.getCoalescedEvents?.() ?? [];
    for (const sample of coalesced.length ? coalesced : [event]) {
      if (sample.pointerType === "pen" && sample.pressure <= 0) { flush(); eraserRemaining = undefined; continue; }
      const nextTool = (sample.buttons & 32) !== 0 ? "eraser" : state.tool;
      if (active && active.tool !== nextTool) { flush(); eraserRemaining = undefined; }
      if (!active) { start(sample, rect, origin); continue; }
      const next = pointFrom(sample, rect, origin);
      if (active.tool === "pen") {
        if (liveCtx) paintSegment(liveCtx, active.points.at(-1)!, next, state.draft!.color);
        active.points.push(next);
        if (painted?.activeStroke === active) painted.activePoints = active.points.length;
      } else {
        active.points.push(next);
      }
    }
    const currentDraft = state.draft;
    if (currentDraft && active?.tool === "eraser") {
      const remaining = eraserRemaining ?? visibleStrokes(currentDraft.strokes);
      const nextRemaining = remaining.filter(stroke => !touchesStroke(stroke, active!));
      if (nextRemaining.length < remaining.length) {
        eraserRemaining = nextRemaining;
        render();
      } else {
        eraserRemaining = remaining;
      }
    }
  };
  const finish = (event: PointerEvent) => {
    if (pointerId !== event.pointerId) return;
    const draft = state.draft;
    const rect = getRect();
    if (panDrag && event.type === "pointerup" && event.pointerType !== "pen") sheets.setPan(state,
      { x: panDrag.pan.x + event.clientX - panDrag.x, y: panDrag.pan.y + event.clientY - panDrag.y });
    if (active && draft && event.type === "pointerup" && event.pointerType !== "pen") {
      const origin = viewOrigin(rect.width, rect.height, state.pan, draft.height);
      const next = pointFrom(event, rect, origin);
      if (active.tool === "pen" && liveCtx && painted?.activeStroke === active) {
        const po = painted.width === rect.width && painted.height === rect.height ? origin : viewOrigin(painted.width, painted.height, state.pan, draft.height);
        const sx = canvas.width / painted.width, sy = canvas.height / painted.height;
        liveCtx.setTransform(sx, 0, 0, sy, po.x * sx, po.y * sy);
        paintSegment(liveCtx, active.points.at(-1)!, next, draft.color);
        active.points.push(next);
        painted.activePoints = active.points.length;
      } else {
        active.points.push(next);
      }
    }
    pointerId = undefined; eraserRemaining = undefined;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    const didCommit = Boolean(active && draft && draft.id === activeDraftId);
    flush();
    if (!didCommit) render();
  };
  canvas.addEventListener("pointerdown", down, { signal });
  canvas.addEventListener("pointermove", move, { signal });
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"] as const) canvas.addEventListener(name, finish, { signal });
  canvas.addEventListener("contextmenu", event => event.preventDefault(), { signal });
  viewport.addEventListener("wheel", event => event.preventDefault(), { signal, passive: false });
  const unsubscribe = sheets.onChange(render);
  const resize = new ResizeObserver(() => { canvasRect = undefined; render(); }); resize.observe(viewport);
  const dispose = () => {
    if (disposed) return;
    disposed = true; flush(); pointerId = undefined; eraserRemaining = undefined;
    unsubscribe(); resize.disconnect(); referenceMount?.dispose();
    for (const button of buttons) button.dispose();
    signal.removeEventListener("abort", dispose); root.remove();
  };
  signal.addEventListener("abort", dispose, { once: true });
  render();
  if (preparing) void (async () => {
    try {
      await frame(signal);
      signal.throwIfAborted();
      const width = viewport.clientWidth, height = viewport.clientHeight;
      const content = referenceFor(input);
      let slots: HTMLElement[] = [];
      if (content) {
        reference = document.createElement("div"); reference.className = "drawing-pad-reference";
        // CSS mirrors the native composer's normal question-content width,
        // independent of the viewport. Freeze that wrapping once for this sheet.
        reference.setAttribute("aria-hidden", "true");
        root.append(reference);
        referenceMount = mountReference(reference, ctx, content, signal); slots = referenceMount.slots;
      }
      let palette: string, sheet: Awaited<ReturnType<typeof captureBackground>>;
      do {
        palette = appPalette().key;
        sheet = await captureBackground(reference, slots, width, height, getComputedStyle(root).backgroundColor, signal);
      } while (palette !== appPalette().key);
      if (disposed || signal.aborted) return;
      preparing = false;
      sheets.create(state, { ...sheet, reference: content, palette });
    } catch (error) {
      if (!disposed && !signal.aborted) {
        preparing = false; failure = `Could not prepare the drawing background. ${error instanceof Error ? error.message : ""} Close and reopen Draw to try again.`;
        render();
      }
    } finally { referenceMount?.dispose(); reference?.remove(); }
  })();
  return { flush, dispose, canUseEditingShortcuts, canUndo, undo: undoHistory, togglePenEraser, selectHand };
}
