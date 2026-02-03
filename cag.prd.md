## PRD: Computer Aided Geometric Construction Tool

### Goal
A full-screen, browser-based geometric construction tool that mimics compass-and-straightedge drafting. Users draw infinite lines and full circles, then “ink” specific segments between intersections to create boundaries, and finally flood-fill enclosed regions.

### Platform / Tech
- plain javascript
- preact, preact signals
- Fullscreen `<canvas>`
- Pointer + keyboard input
- infinite canvas with standard controls for pan and zoom
- mobile friendly: touch support, responsive rendering

### Core Concepts / Data Model

**Primitives (blue construction geometry)**
- `Line`: infinite line defined by two points `p0, p1`
- `Circle`: full circle defined by center `c` and radius point `rp`
- `Measure`: small arc defined by a center `c` and radius point `rp`
- Each primitive has stable `id`
- all intersections between primitives are stored with stable ids

**Ink (black boundary geometry)**
- User-created segments that lie on a single primitive between two intersection points
- Stored as: { primitiveId, intersectionA, intersectionB }
- each segment has a stable `id`

**Fill (color regions)**
- Raster fill buffer aligned to world canvas dimensions
- stored as an array of segments that surround the region to be filled
- each fill region has a stable `id`

### 5) View / Coordinate System
- “World” coordinates are in CSS pixels of the viewport.
- View transform: `scale` + `panX/panY` applied to world → screen.
- Zoom at cursor; pan by dragging.

### 6) Tools & UX
Toolbar + hotkeys:

1. **Compass (1)**
   - Click #1 sets center
   - Click #2 sets radius (distance to center) and commits full circle
   - Preview while pending
   - Circle and center point are both drawn in pale blue
2. **Straightedge (2)**
   - Click #1 sets anchor point
   - Click #2 sets direction and commits infinite line (clipped to canvas for rendering)
   - Preview while pending
   - full line drawn in pale blue
3. **Ink (3)**
   - Click on a primitive to ink exactly one segment:
     - For a line: the segment between the nearest two adjacent intersection parameters surrounding the click; if none, between viewport clip endpoints.
     - For a circle: the arc segment between adjacent intersection angles containing the click; if <2 intersections, ink full circle.
   - ink is drawn as thick black line
4. **Fill (4)**
   - Click fills the clicked region with current fill color using ink as boundaries.
   - Fill is **rejected unless region is fully enclosed by ink**, implemented as: flood fill must not reach the world boundary; ink mask lines are treated as walls.
5. **Copy Measure (5)**
   - Click #1 identify first point to measure from
   - Click #2 identify second point to measure to
   - preview: show center point and track the mouse for the second point and connect with a line
   - stores the distance between the two points
6. **Paste Measure (6)**
   - Click #1 identify the starting point
   - show the dotted line of a circle where the radius is equal to the copied measure distance
   - Click #2 create a short pale blue arc on the circle where the user's mouse is at the correct distance
   - any intersection between the arcs and other arcs, lines, or circles should be marked
7. **Select (7)**
   - Click selects a line/circle (visual highlight).
   - Delete/backspace removes selected primitive and dependent artifacts (see deletion rules).

### 7) Snapping
While drawing a circle or line, the mouse should snap to any existing primitives using the following priority rules:
- Any intersection point
- Nearest point on any existing line
- Nearest point on any existing circle
- Nearest point on any measure arc

The point or primitive being snapped to should be highlighted

### 8) Rendering Rules
- Background: white.
- Construction primitives: faint blue stroke (selected primitive slightly stronger blue).
- Intersections: blue dots
- Ink segments: black with **lineWidth 2** in final render.
- Fill:
  - Internally, fill should be computed against an ink mask drawn at **lineWidth 1**, then the final render should draw ink at **lineWidth 2** to avoid white seams.

### 9) Pan / Zoom Controls
- Pan: hold **Space** and drag, or middle-mouse drag.
- Zoom: mouse wheel (zoom at cursor), plus `+/-` optional.
- Reset view: `0`.
- When select tool is selected, user can click and drag on canvas to pan
- ensure all drawing and preview lines/circles are done in world coordinates and respect the current zoom/pan

### 10) Undo / Redo
- Undo: `Z`
- Redo: `Y`
- Clear all: `X`
- Any user action that changes state must push an undoable operation:
  - add primitive
  - add ink segment
  - fill patch
  - delete primitive (including cascading deletes)
  - clear all

### 11) Deletion Semantics (Cascades)
When deleting a primitive (line/circle):
1. Remove the primitive.
2. Remove any ink segments whose `primId` is the deleted primitive.
3. Recompute intersections.
4. Remove (“prune”) any remaining ink segments on other primitives that became invalid because their endpoints were defined by intersections that no longer exist.
   - For lineSeg: endpoints must match either current intersection points on that line or the current viewport clip endpoints (within tolerance).
   - For arcSeg: endpoints’ angles must exist in the current angle list (within tolerance); full-circle ink only valid if circle has <2 intersections.
5. Remove ("prune") any fill regions bounded by any of the removed segments

Undo must restore primitives, ink, and fills to previous state.

### 12) Fill Behavior Details
- Build a boundary mask from ink segments (1px wide).
- Flood fill from clicked pixel; reject if the flood reaches any boundary of the fill buffer (meaning region is not enclosed).
