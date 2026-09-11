# transport

`transport` is Tide's authenticated WebSocket server. It owns connection
limits, request correlation and idempotency, subscriptions, runtime event
sequencing, and the bounded replay journal.

Production code depends only on [`protocol`](../protocol). Runtime behavior is
provided through the `Backend` trait, keeping provider, database, filesystem,
Git, and UI code outside the transport boundary.
