//! The Memory page shell: routes the RAG panel and the knowledge-source
//! registry layout mounted by the memory settings screen.

use crate::theme::Theme;
use gpui::prelude::*;
use gpui::{AnyElement, Context, px};
use gpui::{SharedString, Window, div};

use crate::app::Tide;
use crate::ui::card::settings_page_header;

impl Tide {
    pub(in crate::app) fn render_memory_settings(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = Theme::current(cx);
        div()
            .flex()
            .flex_col()
            .gap(px(26.0))
            .child(settings_page_header(
                &theme,
                tr!("settings.memory"),
                Some(SharedString::from(tr!("settings.memory_description"))),
                None,
            ))
            .child(
                div()
                    .flex()
                    .items_start()
                    .gap(px(26.0))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap(px(26.0))
                            .child(self.render_rag_model_card(&theme, cx))
                            .child(self.render_rag_endpoints_card(&theme, cx))
                            .child(self.render_rag_retrieval_card(window, &theme, cx)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap(px(26.0))
                            .child(self.render_sources_card(&theme, cx))
                            .child(self.render_library_card(&theme, cx)),
                    ),
            )
            .children(self.render_rag_rebuild_progress(&theme, cx))
            .into_any_element()
    }
}
