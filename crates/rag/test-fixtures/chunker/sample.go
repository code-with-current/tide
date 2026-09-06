// Go fixture — func, method, type, const.
package calc

const MaxSize = 1024

func Add(a, b int) int {
	return a + b
}

func (c *Calculator) Apply(x int) int {
	return c.base + x
}

type Calculator struct {
	base int
}
