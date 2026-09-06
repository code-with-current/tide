// Rust fixture — fn, struct, enum, impl, const, type alias.
pub const MAX_SIZE: usize = 1024;

pub type Point = (f64, f64);

pub fn calculate(a: i64, b: i64) -> i64 {
    a + b
}

pub struct Calculator {
    base: i64,
}

impl Calculator {
    pub fn new(base: i64) -> Self {
        Self { base }
    }
}

pub enum Op {
    Add,
    Sub,
}
