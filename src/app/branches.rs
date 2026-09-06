use super::composer::visible_branch_entries;
use super::*;

enum BranchOperation {
    Checkout(String),
    Create(String),
}

/// Which surface opened the shared branch picker — the only per-site seams
/// are the search placeholder and where focus returns when it closes.
#[derive(Clone, Copy, Eq, PartialEq)]
pub(super) enum BranchPickerSurface {
    Composer,
    GitPanel,
}

/// The per-site inputs of the shared branch picker popover: the menu id it
/// registers under, the workspace whose branches it lists, and whether the
/// selection is a planned worktree base (which disables the create flow and
/// the real checkout).
pub(super) struct BranchPickerContext {
    pub menu_id: SharedString,
    pub workspace_path: PathBuf,
    pub planned_worktree: bool,
    pub surface: BranchPickerSurface,
}

impl Tide {
    pub(super) fn sync_branch_picker_rows(&self, rows: &[crate::git_branch::BranchEntry]) {
        let mut cached = self.branch_picker_row_cache.borrow_mut();
        if cached.as_slice() == rows {
            return;
        }
        *cached = rows.to_vec();
        self.branch_picker_list_state
            .reset_with_uniform_height(rows.len(), px(BRANCH_PICKER_ROW_HEIGHT));
    }

    /// Read the selected workspace's cached Git branches, starting one
    /// background fetch on a miss. The previous selected-path snapshot remains
    /// drawable while an invalidation is being refreshed.
    pub(super) fn branch_snapshot_for_workspace(
        &mut self,
        workspace_path: &std::path::Path,
        cx: &mut Context<Self>,
    ) -> Option<BranchSnapshot> {
        let workspace_path = workspace_path.to_path_buf();
        let fallback = self
            .visible_branch_snapshot
            .as_ref()
            .filter(|(path, _)| path == &workspace_path)
            .map(|(_, snapshot)| snapshot.clone());

        match self.branch_snapshots.read(&workspace_path) {
            Query::Ready(result) => match result.as_ref() {
                Ok(Some(snapshot)) => {
                    let snapshot = snapshot.clone();
                    self.cache_sidebar_branch_label(&workspace_path, snapshot.display_branch());
                    self.visible_branch_snapshot = Some((workspace_path, snapshot.clone()));
                    Some(snapshot)
                }
                Ok(None) => {
                    self.cache_sidebar_branch_label(&workspace_path, None);
                    if self
                        .visible_branch_snapshot
                        .as_ref()
                        .is_some_and(|(path, _)| path == &workspace_path)
                    {
                        self.visible_branch_snapshot = None;
                    }
                    None
                }
                Err(_) => fallback,
            },
            Query::Pending => fallback,
            Query::Missing(token) => {
                let fetch_path = workspace_path.clone();
                let workspace = client::WorkspaceClient::new(self.daemon.client());
                cx.spawn(async move |tide, cx| {
                    let result = cx
                        .background_executor()
                        .spawn({
                            let fetch_path = fetch_path.clone();
                            async move {
                                match workspace.request(
                                    client::WorkspaceOperation::InspectBranches {
                                        cwd: fetch_path.clone(),
                                    },
                                ) {
                                    Ok(client::WorkspaceResult::Branches { snapshot }) => {
                                        Ok(snapshot)
                                    }
                                    Ok(_) => {
                                        Err("the daemon returned an invalid branch response"
                                            .to_owned())
                                    }
                                    Err(error) => Err(error.to_string()),
                                }
                            }
                        })
                        .await;
                    let _ = tide.update(cx, |tide, cx| {
                        if !tide.branch_snapshots.fulfill(token, result.clone()) {
                            return;
                        }
                        match &result {
                            Ok(Some(snapshot)) => tide
                                .cache_sidebar_branch_label(&fetch_path, snapshot.display_branch()),
                            Ok(None) => tide.cache_sidebar_branch_label(&fetch_path, None),
                            Err(_) => {}
                        }
                        let selected = tide
                            .selected_workspace_path()
                            .is_some_and(|path| path == fetch_path);
                        if selected {
                            match result {
                                Ok(Some(snapshot)) => {
                                    let mut persisted_branch_changed = false;
                                    if let Some(current) = snapshot.current.as_deref()
                                        && let Some(session) = tide.selected_session_mut()
                                        && let SessionWorkspace::Worktree { branch, .. } =
                                            &mut session.workspace
                                        && branch != current
                                    {
                                        *branch = current.to_owned();
                                        persisted_branch_changed = true;
                                    }
                                    tide.visible_branch_snapshot = Some((fetch_path, snapshot));
                                    if persisted_branch_changed {
                                        tide.save();
                                    }
                                }
                                Ok(None) => tide.visible_branch_snapshot = None,
                                Err(_) => {}
                            }
                            cx.notify();
                        }
                    });
                })
                .detach();
                fallback
            }
        }
    }

    pub(super) fn refresh_selected_branch_snapshot(&mut self, cx: &mut Context<Self>) {
        let Some(path) = self
            .selected_workspace_path()
            .map(std::path::Path::to_path_buf)
        else {
            self.visible_branch_snapshot = None;
            return;
        };
        self.branch_snapshots.invalidate(&path);
        cx.notify();
    }

    /// Select an existing branch. A planned worktree remembers it as the base
    /// ref without touching the ordinary checkout; concrete workspaces run a
    /// real `git switch` on the background executor.
    ///
    /// `true` asks the caller to dismiss the picker after this entity update
    /// ends. Closing sooner runs the toggle observer, which re-enters `Tide`
    /// and double-leases the entity.
    pub(super) fn choose_workspace_branch(
        &mut self,
        branch: String,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(session) = self.selected_session() else {
            return false;
        };
        if session.is_busy() || self.branch_operation_pending {
            return false;
        }
        if matches!(session.workspace, SessionWorkspace::NewWorktree { .. }) {
            let changed = self.selected_session_mut().is_some_and(|session| {
                let SessionWorkspace::NewWorktree { base_branch } = &mut session.workspace else {
                    return false;
                };
                if base_branch.as_deref() == Some(branch.as_str()) {
                    return false;
                }
                *base_branch = Some(branch);
                true
            });
            if changed {
                self.save();
                cx.notify();
            }
            return true;
        }

        let Some(path) = self
            .selected_workspace_path()
            .map(std::path::Path::to_path_buf)
        else {
            return false;
        };
        if self
            .visible_branch_snapshot
            .as_ref()
            .filter(|(snapshot_path, _)| snapshot_path == &path)
            .and_then(|(_, snapshot)| snapshot.current.as_deref())
            == Some(branch.as_str())
        {
            return true;
        }
        self.start_branch_operation(path, BranchOperation::Checkout(branch), cx);
        true
    }

    pub(super) fn begin_branch_creation(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.branch_operation_pending
            || self.selected_session().is_none_or(|session| {
                session.is_busy()
                    || matches!(session.workspace, SessionWorkspace::NewWorktree { .. })
            })
        {
            return;
        }
        self.branch_picker_mode = BranchPickerMode::Create;
        self.branch_picker_highlight = None;
        self.branch_create_input
            .update(cx, |input, cx| input.clear(cx));
        let focus = self.branch_create_input.read(cx).focus_handle(cx);
        window.on_next_frame(move |window, _| {
            window.on_next_frame(move |window, cx| window.focus(&focus, cx));
        });
        cx.notify();
    }

    /// Escape from the create form: back to browsing with the filter
    /// refocused — the reverse of [`begin_branch_creation`], with the same
    /// double-frame focus dance because the search field only exists once
    /// the browse body has rendered.
    ///
    /// [`begin_branch_creation`]: Self::begin_branch_creation
    pub(super) fn cancel_branch_creation(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.branch_picker_mode = BranchPickerMode::Browse;
        self.branch_picker_highlight = None;
        let focus = self.branch_search.read(cx).focus_handle(cx);
        window.on_next_frame(move |window, _| {
            window.on_next_frame(move |window, cx| window.focus(&focus, cx));
        });
        cx.notify();
    }

    pub(super) fn confirm_branch_creation(&mut self, cx: &mut Context<Self>) -> bool {
        if self.branch_picker_mode != BranchPickerMode::Create || self.branch_operation_pending {
            return false;
        }
        let branch = self
            .branch_create_input
            .read(cx)
            .content()
            .trim()
            .to_owned();
        if branch.is_empty() {
            return false;
        }
        let Some(path) = self
            .selected_workspace_path()
            .map(std::path::Path::to_path_buf)
        else {
            return false;
        };
        self.start_branch_operation(path, BranchOperation::Create(branch), cx);
        true
    }

    pub(super) fn move_branch_picker_highlight(
        &mut self,
        key: &str,
        actions: &[BranchPickerAction],
        cx: &mut Context<Self>,
    ) {
        if self.branch_picker_mode != BranchPickerMode::Browse || actions.is_empty() {
            return;
        }
        let current = self
            .branch_picker_highlight
            .filter(|index| *index < actions.len());
        let next = match (key, current) {
            ("up", Some(0)) => actions.len() - 1,
            ("up", Some(index)) => index - 1,
            ("up", None) => actions.len() - 1,
            (_, Some(index)) => (index + 1) % actions.len(),
            (_, None) => 0,
        };
        self.branch_picker_highlight = Some(next);
        if let Some(BranchPickerAction::Checkout(branch)) = actions.get(next)
            && let Some(row) = self
                .branch_picker_row_cache
                .borrow()
                .iter()
                .position(|entry| entry.name == *branch)
        {
            self.branch_picker_list_state.scroll_to_reveal_item(row);
        }
        cx.notify();
    }

    /// Apply the keyboard-selected action, returning whether the caller should
    /// dismiss the picker after releasing its `Tide` update lease.
    pub(super) fn confirm_branch_picker_action(
        &mut self,
        actions: &[BranchPickerAction],
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.branch_picker_mode == BranchPickerMode::Create {
            return self.confirm_branch_creation(cx);
        }
        let Some(action) = actions.get(self.branch_picker_highlight.unwrap_or(0)) else {
            return false;
        };
        match action {
            BranchPickerAction::Checkout(branch) => {
                self.choose_workspace_branch(branch.clone(), cx)
            }
            BranchPickerAction::Create => {
                self.begin_branch_creation(window, cx);
                false
            }
        }
    }

    fn start_branch_operation(
        &mut self,
        path: PathBuf,
        operation: BranchOperation,
        cx: &mut Context<Self>,
    ) {
        if self.branch_operation_pending {
            return;
        }
        self.branch_operation_pending = true;
        cx.notify();
        let workspace = client::WorkspaceClient::new(self.daemon.client());
        cx.spawn(async move |tide, cx| {
            let result = cx
                .background_executor()
                .spawn({
                    let path = path.clone();
                    async move {
                        let (branch, create) = match operation {
                            BranchOperation::Checkout(branch) => (branch, false),
                            BranchOperation::Create(branch) => (branch, true),
                        };
                        match workspace.request(client::WorkspaceOperation::CheckoutBranch {
                            cwd: path,
                            branch,
                            create,
                            start_point: None,
                        })? {
                            client::WorkspaceResult::BranchChanged { snapshot } => Ok(snapshot),
                            _ => anyhow::bail!("the daemon returned an invalid branch response"),
                        }
                    }
                })
                .await;
            let _ = tide.update(cx, |tide, cx| {
                tide.branch_operation_pending = false;
                match result {
                    Ok(snapshot) => {
                        let current = snapshot.current.clone();
                        tide.cache_sidebar_branch_label(&path, snapshot.display_branch());
                        tide.visible_branch_snapshot = Some((path.clone(), snapshot));
                        tide.branch_snapshots.invalidate(&path);
                        let selected_path = tide
                            .selected_workspace_path()
                            .map(std::path::Path::to_path_buf);
                        if selected_path.as_ref() == Some(&path) {
                            if let Some(current) = current
                                && let Some(session) = tide.selected_session_mut()
                                && let SessionWorkspace::Worktree { branch, .. } =
                                    &mut session.workspace
                            {
                                *branch = current;
                            }
                            tide.invalidate_workspace_queries(cx);
                            tide.reload_clean_right_panel_file_editors(cx);
                            tide.save();
                        }
                    }
                    Err(error) => {
                        tide.show_toast(tr!("errors.change_branch", error = error));
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// The shared branch picker popover — the search-filtered branch list
    /// with keyboard highlight navigation and the inline create form, over
    /// the same `Tide` picker state every surface uses. The trigger chip is
    /// the caller's: `build_trigger` receives whether the menu is open and
    /// the resolved selected branch so it can label and highlight itself,
    /// and `selected_from_snapshot` derives that branch per surface (the
    /// composer is workspace-aware; the Git panel shows the checked-out
    /// branch). `None` means no branch snapshot exists yet for the
    /// workspace — callers fall back to their own static presentation.
    pub(super) fn render_branch_picker<E>(
        &mut self,
        context: BranchPickerContext,
        enabled: bool,
        selected_from_snapshot: impl FnOnce(&BranchSnapshot) -> String,
        build_trigger: impl FnOnce(bool, &str) -> E,
        align: MenuAlign,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement>
    where
        E: ParentElement + Styled + InteractiveElement + IntoElement + 'static,
    {
        let theme = Theme::current(cx);
        let planned_worktree = context.planned_worktree;
        let surface = context.surface;
        let snapshot = self.branch_snapshot_for_workspace(&context.workspace_path, cx)?;
        let selected_branch = selected_from_snapshot(&snapshot);

        let weak = cx.entity().downgrade();
        let search = self.branch_search.clone();
        let create_input = self.branch_create_input.clone();
        let search_focus = search.read(cx).focus_handle(cx);
        let handle = {
            let toggle_weak = weak.clone();
            let reset_search = search.clone();
            let reset_create = create_input.clone();
            let picker_focus = search_focus.clone();
            self.menu_handle_with(context.menu_id, cx, move |open, window, cx| {
                let _ = toggle_weak.update(cx, |this, cx| {
                    if open {
                        this.branch_picker_mode = BranchPickerMode::Browse;
                        this.branch_picker_highlight = None;
                        let placeholder = match surface {
                            BranchPickerSurface::Composer => {
                                let project_name = this
                                    .selected_project()
                                    .map(Project::display_name)
                                    .unwrap_or_else(|| tr!("project.project_lower"));
                                tr!("branches.search_project", project = project_name)
                            }
                            BranchPickerSurface::GitPanel => tr!("git_panel.search_branches"),
                        };
                        reset_search.update(cx, |input, cx| {
                            input.set_placeholder(placeholder, cx);
                            input.clear(cx);
                        });
                        reset_create.update(cx, |input, cx| input.clear(cx));
                        this.refresh_selected_branch_snapshot(cx);
                    } else {
                        this.branch_picker_mode = BranchPickerMode::Browse;
                        if surface == BranchPickerSurface::Composer {
                            let focus = this.composer_focus(cx);
                            window.focus(&focus, cx);
                        }
                    }
                    cx.notify();
                });
                if open {
                    let picker_focus = picker_focus.clone();
                    window.on_next_frame(move |window, _| {
                        window.on_next_frame(move |window, cx| window.focus(&picker_focus, cx));
                    });
                }
            })
        };

        let trigger = build_trigger(handle.is_open(), &selected_branch);
        if !enabled {
            return Some(trigger.into_any_element());
        }

        let normalized_query = self
            .branch_search
            .read(cx)
            .content()
            .trim()
            .to_ascii_lowercase();
        let visible_branches = Rc::new(
            if handle.is_open() && self.branch_picker_mode == BranchPickerMode::Browse {
                visible_branch_entries(&snapshot.branches, &selected_branch, &normalized_query)
            } else {
                Vec::new()
            },
        );
        let allow_create = !planned_worktree;
        let actions = Rc::new(
            visible_branches
                .iter()
                .filter(|branch| planned_worktree || !branch.checked_out_elsewhere)
                .map(|branch| BranchPickerAction::Checkout(branch.name.clone()))
                .chain(allow_create.then_some(BranchPickerAction::Create))
                .collect::<Vec<_>>(),
        );
        let highlight = self
            .branch_picker_highlight
            .filter(|index| *index < actions.len());
        let mode = self.branch_picker_mode;
        if handle.is_open() && mode == BranchPickerMode::Browse {
            self.sync_branch_picker_rows(&visible_branches);
        }
        let branch_list = self.branch_picker_list_state.clone();

        Some(popover(
            trigger,
            &handle,
            align,
            move |popover, _window, _cx| {
                let popover = popover.clone();
                let next_actions = actions.clone();
                let previous_actions = actions.clone();
                let confirm_actions = actions.clone();
                let dismiss_weak = weak.clone();
                let next_weak = weak.clone();
                let previous_weak = weak.clone();
                let confirm_weak = weak.clone();
                let confirm_popover = popover.clone();

                let body = if mode == BranchPickerMode::Create {
                    div()
                        .w_full()
                        .p(px(14.0))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.0))
                                .text_size(sp(13.0))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.text)
                                .child(icon("icons/plus.svg", 14.0, theme.text_secondary))
                                .child(tr!("branches.create_and_checkout")),
                        )
                        .child(
                            div()
                                .mt(px(12.0))
                                .h(px(36.0))
                                .px(px(10.0))
                                .rounded(px(9.0))
                                .border_1()
                                .border_color(theme.border_strong)
                                .bg(theme.surface)
                                .flex()
                                .items_center()
                                .child(div().flex_1().min_w_0().child(create_input.clone())),
                        )
                        .child(
                            div()
                                .mt(px(9.0))
                                .text_size(sp(12.5))
                                .text_color(theme.text_tertiary)
                                .child(tr!("branches.create_hint")),
                        )
                        .into_any_element()
                } else {
                    let rows = if visible_branches.is_empty() {
                        div()
                            .id("branch-picker-list-empty")
                            .h(px(64.0))
                            .flex_none()
                            .flex()
                            .items_center()
                            .justify_center()
                            .text_size(sp(12.5))
                            .text_color(theme.text_ghost)
                            .child(tr!("branches.none_found"))
                            .into_any_element()
                    } else {
                        let list_branches = visible_branches.clone();
                        let list_actions = actions.clone();
                        let list_selected_branch = selected_branch.clone();
                        let list_weak = weak.clone();
                        let list_popover = popover.clone();
                        let height =
                            (visible_branches.len() as f32 * BRANCH_PICKER_ROW_HEIGHT).min(260.0);
                        div()
                            .id("branch-picker-list")
                            .w_full()
                            .h(px(height))
                            .flex_none()
                            .px(px(4.0))
                            .child(
                                list(branch_list.clone(), move |index, _window, _cx| {
                                    let Some(branch) = list_branches.get(index) else {
                                        return div().into_any_element();
                                    };
                                    let selected = branch.name == list_selected_branch;
                                    let disabled =
                                        branch.checked_out_elsewhere && !planned_worktree;
                                    let highlighted = highlight
                                        .and_then(|index| list_actions.get(index))
                                        .is_some_and(|action| {
                                            matches!(
                                                action,
                                                BranchPickerAction::Checkout(name)
                                                    if name == &branch.name
                                            )
                                        });
                                    let color = if disabled {
                                        theme.text_ghost
                                    } else {
                                        theme.text
                                    };
                                    let row = div()
                                        .id(SharedString::from(format!(
                                            "branch-row-{}",
                                            branch.name
                                        )))
                                        .w_full()
                                        .h(px(BRANCH_PICKER_ROW_HEIGHT))
                                        .px(px(8.0))
                                        .rounded(px(6.0))
                                        .flex()
                                        .items_center()
                                        .gap(px(8.0))
                                        .cursor_default()
                                        .when(highlighted, |element| {
                                            element.bg(theme.overlay_strong)
                                        })
                                        .when(!disabled, |element| {
                                            element
                                                .hover(|element| element.bg(theme.overlay))
                                                .active(|element| element.opacity(0.85))
                                        })
                                        .child(icon("icons/git-branch.svg", 12.0, color))
                                        .child(
                                            div()
                                                .min_w_0()
                                                .flex_1()
                                                .truncate()
                                                .text_size(sp(12.5))
                                                .line_height(sp(15.0))
                                                .text_color(color)
                                                .child(SharedString::from(branch.name.clone())),
                                        )
                                        .when(selected, |element| {
                                            element.child(icon(
                                                "icons/check.svg",
                                                11.0,
                                                theme.text_secondary,
                                            ))
                                        });
                                    if disabled {
                                        row.into_any_element()
                                    } else {
                                        let branch_name = branch.name.clone();
                                        let select_weak = list_weak.clone();
                                        let select_popover = list_popover.clone();
                                        row.on_click(move |_, window, cx| {
                                            let should_close = select_weak
                                                .update(cx, |this, cx| {
                                                    this.choose_workspace_branch(
                                                        branch_name.clone(),
                                                        cx,
                                                    )
                                                })
                                                .unwrap_or(false);
                                            if should_close {
                                                select_popover.close(window, cx);
                                                window.refresh();
                                            }
                                        })
                                        .into_any_element()
                                    }
                                })
                                .size_full(),
                            )
                            .into_any_element()
                    };

                    let create_row = allow_create.then(|| {
                        let create_weak = weak.clone();
                        div()
                            .id("create-workspace-branch")
                            .mx(px(4.0))
                            .h(px(BRANCH_PICKER_ROW_HEIGHT))
                            .px(px(8.0))
                            .rounded(px(6.0))
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .cursor_default()
                            .when(
                                highlight.and_then(|index| actions.get(index))
                                    == Some(&BranchPickerAction::Create),
                                |element| element.bg(theme.overlay_strong),
                            )
                            .hover(|element| element.bg(theme.overlay))
                            .active(|element| element.opacity(0.85))
                            .child(icon("icons/plus.svg", 12.0, theme.text_secondary))
                            .child(
                                div()
                                    .text_size(sp(12.5))
                                    .line_height(sp(15.0))
                                    .text_color(theme.text)
                                    .child(tr!("branches.create_and_checkout_ellipsis")),
                            )
                            .on_click(move |_, window, cx| {
                                let _ = create_weak.update(cx, |this, cx| {
                                    this.begin_branch_creation(window, cx);
                                });
                            })
                    });

                    div()
                        .w_full()
                        .flex()
                        .flex_col()
                        .child(
                            div()
                                .h(px(52.0))
                                .px(px(12.0))
                                .pt(px(10.0))
                                .pb(px(8.0))
                                .flex_none()
                                .flex()
                                .items_center()
                                .child(
                                    div()
                                        .w_full()
                                        .h(px(34.0))
                                        .px(px(10.0))
                                        .rounded(px(9.0))
                                        .bg(theme.surface)
                                        .flex()
                                        .items_center()
                                        .gap(px(8.0))
                                        .child(icon("icons/search.svg", 15.0, theme.text_secondary))
                                        .child(div().flex_1().min_w_0().child(search.clone())),
                                ),
                        )
                        .child(
                            div()
                                .px(px(14.0))
                                .pt(px(3.0))
                                .pb(px(7.0))
                                .text_size(sp(12.5))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.text_tertiary)
                                .child(tr!("branches.title")),
                        )
                        .child(rows)
                        .when_some(create_row, |element, create_row| {
                            element
                                .child(div().mx(px(6.0)).my(px(4.0)).h(px(1.0)).bg(theme.border))
                                .child(create_row)
                                .child(div().h(px(4.0)))
                        })
                        .into_any_element()
                };

                div()
                    .w(px(360.0))
                    .max_h(px(390.0))
                    .rounded(px(13.0))
                    .overflow_hidden()
                    .border_1()
                    .border_color(theme.border_strong)
                    .bg(theme.raised)
                    .shadow_lg()
                    .flex()
                    .flex_col()
                    .on_action(move |_: &SelectNextEntry, _, cx| {
                        let _ = next_weak.update(cx, |this, cx| {
                            this.move_branch_picker_highlight("down", &next_actions, cx);
                        });
                    })
                    .on_action(move |_: &SelectPreviousEntry, _, cx| {
                        let _ = previous_weak.update(cx, |this, cx| {
                            this.move_branch_picker_highlight("up", &previous_actions, cx);
                        });
                    })
                    .on_action(move |_: &ConfirmEntry, window, cx| {
                        let should_close = confirm_weak
                            .update(cx, |this, cx| {
                                this.confirm_branch_picker_action(&confirm_actions, window, cx)
                            })
                            .unwrap_or(false);
                        if should_close {
                            confirm_popover.close(window, cx);
                            window.refresh();
                        }
                    })
                    // Escape backs the create form out to browsing. The rest
                    // of the peel is the fields' own clear-on-escape: a
                    // non-empty filter (or typed branch name) clears before
                    // this handler ever sees the keystroke, and an empty
                    // browse view propagates on to the menu's own dismiss.
                    .on_action(move |_: &DismissMenu, window, cx| {
                        let handled = dismiss_weak
                            .update(cx, |this, cx| {
                                if this.branch_picker_mode == BranchPickerMode::Create {
                                    this.cancel_branch_creation(window, cx);
                                    return true;
                                }
                                false
                            })
                            .unwrap_or(false);
                        if !handled {
                            cx.propagate();
                        }
                    })
                    .child(body)
                    .into_any_element()
            },
        ))
    }
}
