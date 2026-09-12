//! The new-task screen: greeting, composer, and workspace chips shown for a
//! selected project before the first prompt is sent.

use gpui::prelude::*;
use gpui::{Context, Div, FontWeight, SharedString, Window, div, px};

use crate::app::CONTENT_MAX_WIDTH;
use crate::app::Tide;
use crate::app::components::project_identity::ProjectNameSelector;
use crate::app::projects_page::project_avatar;
use crate::model::Project;
use crate::theme::{Theme, sp};
use crate::ui::icon;
use crate::ui::menu::{MenuAlign, MenuItem, dropdown_menu};

impl Tide {
    /// The new-session screen: the greeting, the composer, and the workspace
    /// chips — project, Local vs new worktree, base branch — as one
    /// vertically centered composition. The composer is the screen's
    /// centerpiece rather than chrome pinned to the window's bottom edge,
    /// and the git worktree options sit directly under it where the first
    /// prompt is written.
    pub(in crate::app) fn render_new_session_screen(
        &mut self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Div {
        let theme = Theme::current(cx);
        let selected_project_id = self.state.selected_project;
        let projectless_selected = self.selected_project().is_some_and(Project::is_projectless);
        let project_name = self
            .selected_project()
            .map(|project| {
                if project.is_projectless() {
                    tr!("project.without_a_project")
                } else {
                    project.display_name()
                }
            })
            .unwrap_or_else(|| tr!("project.your_project"));
        let project_options = self
            .state
            .projects
            .iter()
            .filter(|project| !project.is_projectless())
            .filter(|project| Some(project.id) == selected_project_id)
            .chain(
                self.state
                    .projects
                    .iter()
                    .filter(|project| !project.is_projectless())
                    .filter(|project| Some(project.id) != selected_project_id),
            )
            .map(|project| {
                let probe = self.landed_probe(project.id);
                (project.clone(), probe, project.display_name())
            })
            .collect::<Vec<_>>();
        let weak = cx.entity().downgrade();
        let handle = self.menu_handle("empty-state-project", cx);
        let project_selector = dropdown_menu(
            ProjectNameSelector::new("empty-state-project", project_name)
                .selected(handle.is_open()),
            "empty-state-project-menu",
            &handle,
            MenuAlign::BelowLeft,
            move |_| {
                let mut items = project_options
                    .clone()
                    .into_iter()
                    .map(|(project, probe, project_name)| {
                        let weak = weak.clone();
                        let project_id = project.id;
                        let is_selected = Some(project_id) == selected_project_id;
                        MenuItem::custom(move |_, cx| {
                            let theme = Theme::current(cx);
                            div()
                                .w_full()
                                .flex()
                                .items_center()
                                .gap(px(8.0))
                                .child(project_avatar(&project, probe.as_ref(), 16.0))
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .truncate()
                                        .text_size(sp(12.5))
                                        .text_color(if is_selected {
                                            theme.text
                                        } else {
                                            theme.text_secondary
                                        })
                                        .child(SharedString::from(project_name.clone())),
                                )
                                .when(is_selected, |element| {
                                    element.child(icon(
                                        "icons/check.svg",
                                        12.0,
                                        theme.text_secondary,
                                    ))
                                })
                                .into_any_element()
                        })
                        .on_click(move |_, cx| {
                            let _ = weak.update(cx, |this, cx| {
                                this.select_project(project_id, cx);
                            });
                        })
                    })
                    .collect::<Vec<_>>();
                if !items.is_empty() {
                    items.push(MenuItem::Separator);
                }
                let add_project_weak = weak.clone();
                items.push(
                    MenuItem::new(tr!("project.new_project"), move |_, cx| {
                        let _ = add_project_weak.update(cx, |this, cx| this.add_project(cx));
                    })
                    .icon("icons/folder-new.svg"),
                );
                let projectless_weak = weak.clone();
                items.push(
                    MenuItem::new(tr!("project.no_project"), move |_, cx| {
                        let _ = projectless_weak.update(cx, |this, cx| {
                            if !this.selected_project().is_some_and(Project::is_projectless) {
                                this.create_projectless_session(cx);
                            }
                        });
                    })
                    .icon("icons/x.svg")
                    .selected(projectless_selected),
                );
                items
            },
        );
        div()
            .flex_1()
            .min_h(px(0.0))
            .w_full()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .px_8()
            // Optical lift: with the composer and its chips below, the
            // block settles slightly above true center.
            .pb(px(48.0))
            .child(
                div()
                    .flex()
                    .items_baseline()
                    .text_size(sp(20.0))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.text)
                    .when(projectless_selected, |element| {
                        element.child(tr_cow!("onboarding.what_should_we_build"))
                    })
                    .when(!projectless_selected, |element| {
                        element
                            .child(tr_cow!("onboarding.what_should_we_build_in"))
                            .child(project_selector)
                            .child(tr_cow!("onboarding.question_mark"))
                    }),
            )
            .child(
                // The composer card and the workspace chips share the
                // transcript's content width and centering, so the git
                // worktree options read as part of the prompt itself.
                div()
                    .mt(px(28.0))
                    .w_full()
                    .max_w(px(CONTENT_MAX_WIDTH))
                    .child(self.render_composer(window, cx))
                    .child(self.render_workspace_footer(cx, MenuAlign::BelowLeft)),
            )
    }
}
