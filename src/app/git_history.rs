//! History-tab commit graph — the Rust port of tide's `commit-graph.tsx`
//! geometry and its painter. The lane assignment itself is pure and lives in
//! `backend` (`assign_lanes`); this module owns the pixel half: the
//! constants, the edge/dot geometry derived once per log refresh (never per
//! frame), and the canvas that paints it.
//!
//! The graph is one tall column rendered behind the virtualized History
//! rows. Rows are transparent for the first 64px so the graph shows through;
//! keeping it a single painter (instead of per-row slices) means
//! virtualization never cuts edges mid-curve. The canvas paints only the
//! edges and dots intersecting the scrolled viewport, culled by y bounds.

use std::sync::Arc;

use gpui::{PathBuilder, point};

use super::*;
use backend::git_panel::assign_lanes;
use protocol::git_panel::PanelCommit;

/// Width of the graph gutter every History row reserves. Keep in sync with
/// the row layout in `right_panel.rs`.
pub(crate) const GRAPH_WIDTH: f32 = 64.0;
/// One History row; the virtualized list is uniform at this height.
pub(crate) const HISTORY_ROW_H: f32 = 24.0;
const LANE_X0: f32 = 14.0;
const LANE_DX: f32 = 9.0;
/// Draw-time lane cap: lanes beyond this clamp onto the last x slot —
/// the layout itself (upstream `assignLanes`) has no cap.
const MAX_LANE: usize = 5;
const LANE_COLOR_COUNT: usize = 6;
const EDGE_STROKE: f32 = 1.5;
const DOT_TIP_RADIUS: f32 = 4.5;
const DOT_RADIUS: f32 = 3.0;

fn lane_x(lane: usize) -> f32 {
    LANE_X0 + lane.min(MAX_LANE) as f32 * LANE_DX
}

/// The lane palette, mapped to theme tokens by x-slot: gauge (blue),
/// favorite (gold), success (green), warning (amber), danger (red), accent
/// (coral) — six hues spread across the theme's status colors, cycled by
/// lane index. Edges take the color of the lane they run along, so a branch
/// keeps one color from tip to merge, like upstream.
pub(crate) fn lane_color(theme: &Theme, lane: usize) -> Hsla {
    match lane % LANE_COLOR_COUNT {
        0 => theme.gauge,
        1 => theme.favorite,
        2 => theme.success,
        3 => theme.warning,
        4 => theme.danger,
        _ => theme.accent,
    }
}

/// One straight or cubic segment of an edge, in graph-column pixel space
/// (origin: top-left of the column, unscrolled).
#[derive(Clone, Copy, Debug)]
enum EdgePart {
    Line {
        from: (f32, f32),
        to: (f32, f32),
    },
    /// SVG `C c1 c2 to` — a cubic Bézier with two control points.
    Cubic {
        from: (f32, f32),
        c1: (f32, f32),
        c2: (f32, f32),
        to: (f32, f32),
    },
}

/// One parent edge: from the child's dot down to the parent's dot (or the
/// fetched window's bottom when the parent lies beyond it). `lane` is the
/// lane the edge runs along — its color.
#[derive(Clone, Debug)]
struct GraphEdge {
    lane: usize,
    /// Inclusive y span, for viewport culling.
    y_min: f32,
    y_max: f32,
    parts: Vec<EdgePart>,
}

/// One commit dot; `lane` selects its color. Tips (HEAD or branch heads)
/// draw larger.
#[derive(Clone, Copy, Debug)]
struct GraphDot {
    x: f32,
    y: f32,
    r: f32,
    lane: usize,
}

/// The whole precomputed graph column — built once per log refresh and
/// stored on `GitPanelState`; frames only read it.
#[derive(Clone, Debug, Default)]
pub(crate) struct HistoryGraph {
    height: f32,
    edges: Vec<GraphEdge>,
    dots: Vec<GraphDot>,
}

impl HistoryGraph {
    /// The lane of row `index`, for row-side accents (branch chip borders).
    pub(crate) fn lane_at(&self, index: usize) -> usize {
        self.dots.get(index).map_or(0, |dot| dot.lane)
    }
}

/// Lays the log out: lane assignment (`backend`) plus edge/dot geometry —
/// the port of `GraphColumnBase`'s path building, minus painting.
pub(crate) fn build_history_graph(commits: &[PanelCommit]) -> Arc<HistoryGraph> {
    let lane_commits: Vec<_> = commits
        .iter()
        .map(backend::git_panel::LaneCommit::from_panel)
        .collect();
    let laid = assign_lanes(&lane_commits);
    let height = (commits.len() as f32 * HISTORY_ROW_H).max(1.0);

    // Parent lookup by sha → row index; parents outside the fetched window
    // draw to the bottom instead.
    let mut row_index: HashMap<&str, usize> = HashMap::with_capacity(commits.len());
    for (index, commit) in commits.iter().enumerate() {
        row_index.insert(commit.sha.as_str(), index);
    }

    let mut edges: Vec<GraphEdge> = Vec::new();
    let mut dots: Vec<GraphDot> = Vec::new();
    for (index, commit) in commits.iter().enumerate() {
        let y = index as f32 * HISTORY_ROW_H + HISTORY_ROW_H / 2.0;
        let lane = laid[index].lane;
        for (parent_index, parent_sha) in commit.parents.iter().enumerate() {
            let edge_lane = if parent_index == 0 {
                lane
            } else {
                laid[index]
                    .merge_from_lanes
                    .get(parent_index - 1)
                    .copied()
                    .unwrap_or(lane)
            };
            let parent = row_index
                .get(parent_sha.as_str())
                .map(|&k| (k as f32 * HISTORY_ROW_H + HISTORY_ROW_H / 2.0, laid[k].lane));
            edges.push(build_edge(lane, edge_lane, y, parent, height));
        }
        let is_tip = commit.is_head || !commit.branch_heads.is_empty();
        dots.push(GraphDot {
            x: lane_x(lane),
            y,
            r: if is_tip { DOT_TIP_RADIUS } else { DOT_RADIUS },
            lane,
        });
    }

    Arc::new(HistoryGraph {
        height,
        edges,
        dots,
    })
}

/// The port of upstream `edgePath`: straight when the edge and both ends sit
/// on one lane; otherwise a cubic split just below the child and a cubic
/// join just above the parent.
fn build_edge(
    child_lane: usize,
    edge_lane: usize,
    y_child: f32,
    parent: Option<(f32, usize)>,
    bottom: f32,
) -> GraphEdge {
    let xs = lane_x(child_lane);
    let xe = lane_x(edge_lane);
    let mut parts: Vec<EdgePart> = Vec::new();
    let Some((y_parent, parent_lane)) = parent else {
        // Parent beyond the fetched window: run to the bottom, bending onto
        // the edge lane within one row.
        let end_y = (y_child + HISTORY_ROW_H).min(bottom);
        if edge_lane == child_lane {
            parts.push(EdgePart::Line {
                from: (xs, y_child),
                to: (xs, bottom),
            });
        } else {
            let mid = (y_child + end_y) / 2.0;
            parts.push(EdgePart::Cubic {
                from: (xs, y_child),
                c1: (xs, mid),
                c2: (xe, mid),
                to: (xe, end_y),
            });
            parts.push(EdgePart::Line {
                from: (xe, end_y),
                to: (xe, bottom),
            });
        }
        return finish_edge(edge_lane, parts);
    };

    let parent_x = lane_x(parent_lane);
    if edge_lane == child_lane && parent_lane == edge_lane {
        parts.push(EdgePart::Line {
            from: (xs, y_child),
            to: (xs, y_parent),
        });
        return finish_edge(edge_lane, parts);
    }
    let split_y = (y_child + HISTORY_ROW_H).min(y_parent);
    let join_y = (y_parent - HISTORY_ROW_H).max(split_y);
    let mut from = (xs, y_child);
    if edge_lane != child_lane {
        let mid = (y_child + split_y) / 2.0;
        parts.push(EdgePart::Cubic {
            from,
            c1: (xs, mid),
            c2: (xe, mid),
            to: (xe, split_y),
        });
        from = (xe, split_y);
    }
    if parent_lane == edge_lane {
        parts.push(EdgePart::Line {
            from,
            to: (xe, y_parent),
        });
    } else {
        parts.push(EdgePart::Line {
            from,
            to: (xe, join_y),
        });
        let mid = (join_y + y_parent) / 2.0;
        parts.push(EdgePart::Cubic {
            from: (xe, join_y),
            c1: (xe, mid),
            c2: (parent_x, mid),
            to: (parent_x, y_parent),
        });
    }
    finish_edge(edge_lane, parts)
}

fn finish_edge(lane: usize, parts: Vec<EdgePart>) -> GraphEdge {
    let y_min = parts
        .iter()
        .map(|part| match part {
            EdgePart::Line { from, .. } | EdgePart::Cubic { from, .. } => from.1,
        })
        .fold(f32::INFINITY, f32::min);
    let y_max = parts
        .iter()
        .map(|part| match part {
            EdgePart::Line { to, .. } | EdgePart::Cubic { to, .. } => to.1,
        })
        .fold(f32::NEG_INFINITY, f32::max);
    GraphEdge {
        lane,
        y_min,
        y_max,
        parts,
    }
}

/// The graph column painter: a viewport-sized canvas translated by the
/// History list's scroll offset, painting only the edges and dots whose y
/// span intersects the viewport. Sized by the caller (`.size_full()` inside
/// an `overflow_hidden` wrapper keeps it clipped to the list).
pub(crate) fn graph_column(
    graph: Arc<HistoryGraph>,
    list_state: ListState,
    theme: &Theme,
) -> impl IntoElement {
    let colors: [Hsla; LANE_COLOR_COUNT] = [
        theme.gauge,
        theme.favorite,
        theme.success,
        theme.warning,
        theme.danger,
        theme.accent,
    ];
    let background = theme.canvas;
    canvas(
        move |_, _, _| (),
        move |bounds, _, window, _| {
            // The list reports its pixel scroll as a non-positive y (GPUI's
            // convention); `scrolled` is the positive down-distance. The
            // graph's content origin moves up by that amount inside the
            // viewport, and the cull window is the slice of graph-space
            // content currently visible — both derived from `scrolled`.
            let scrolled = -f32::from(list_state.scroll_px_offset_for_scrollbar().y);
            let origin_x = f32::from(bounds.origin.x);
            let origin_y = f32::from(bounds.origin.y) - scrolled;
            let top = scrolled - HISTORY_ROW_H;
            let bottom = scrolled + f32::from(bounds.size.height) + HISTORY_ROW_H;
            let pt = |p: (f32, f32)| point(gpui::px(origin_x + p.0), gpui::px(origin_y + p.1));

            for edge in &graph.edges {
                if edge.y_max < top || edge.y_min > bottom {
                    continue;
                }
                let mut builder = PathBuilder::stroke(gpui::px(EDGE_STROKE));
                let mut started = false;
                for part in &edge.parts {
                    match *part {
                        EdgePart::Line { from, to } => {
                            if !started {
                                builder.move_to(pt(from));
                                started = true;
                            }
                            builder.line_to(pt(to));
                        }
                        EdgePart::Cubic { from, c1, c2, to } => {
                            if !started {
                                builder.move_to(pt(from));
                                started = true;
                            }
                            builder.cubic_bezier_to(pt(to), pt(c1), pt(c2));
                        }
                    }
                }
                if let Ok(path) = builder.build() {
                    window.paint_path(path, colors[edge.lane % LANE_COLOR_COUNT].opacity(0.85));
                }
            }

            for dot in &graph.dots {
                if dot.y < top || dot.y > bottom {
                    continue;
                }
                // A background ring separates the dot from the edges behind
                // it, like upstream's stroke="var(--background)".
                let circle = |builder: &mut PathBuilder, radius: f32| {
                    let cx = origin_x + dot.x;
                    let cy = origin_y + dot.y;
                    let r = radius;
                    builder.move_to(point(gpui::px(cx + r), gpui::px(cy)));
                    builder.arc_to(
                        point(gpui::px(r), gpui::px(r)),
                        gpui::px(0.0),
                        false,
                        true,
                        point(gpui::px(cx - r), gpui::px(cy)),
                    );
                    builder.arc_to(
                        point(gpui::px(r), gpui::px(r)),
                        gpui::px(0.0),
                        false,
                        true,
                        point(gpui::px(cx + r), gpui::px(cy)),
                    );
                    builder.close();
                };
                let mut ring = PathBuilder::fill();
                circle(&mut ring, dot.r + 0.75);
                if let Ok(path) = ring.build() {
                    window.paint_path(path, background);
                }
                let mut fill = PathBuilder::fill();
                circle(&mut fill, dot.r);
                if let Ok(path) = fill.build() {
                    window.paint_path(path, colors[dot.lane % LANE_COLOR_COUNT]);
                }
            }
            let _ = graph.height; // height rides along for the caller's layout
        },
    )
    .size_full()
}
