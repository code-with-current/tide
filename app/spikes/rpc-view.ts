import { Electroview } from "electrobun/view";

type SpikeReport = {
  received: number;
  expected: number;
  maxGapMs: number;
  gapsOver100ms: number;
};

type SpikeRPC = {
  bun: {
    requests: {
      reportResults: { params: SpikeReport; response: void };
    };
    messages: {
      ready: void;
    };
  };
  webview: {
    requests: Record<string, never>;
    messages: {
      tick: { n: number; ts: number };
    };
  };
};

const EXPECTED = 4000;
const REPORT_AFTER_FIRST_TICK_MS = 12_000;

let received = 0;
let firstArrival = 0;
let lastArrival = 0;
let maxGapMs = 0;
let gapsOver100ms = 0;
let reportScheduled = false;

function setStatus(text: string) {
  const el = document.getElementById("status");
  if (el) el.textContent = text;
}

function scheduleReport() {
  if (reportScheduled) return;
  reportScheduled = true;
  setTimeout(() => {
    const report: SpikeReport = {
      received,
      expected: EXPECTED,
      maxGapMs: Math.round(maxGapMs),
      gapsOver100ms,
    };
    console.log(`[spike-view] ${JSON.stringify(report)}`);
    setStatus(JSON.stringify(report));
    void rpc.request.reportResults(report);
  }, REPORT_AFTER_FIRST_TICK_MS);
}

const rpc = Electroview.defineRPC<SpikeRPC>({
  handlers: {
    messages: {
      tick: () => {
        const now = performance.now();
        if (firstArrival === 0) {
          firstArrival = now;
          scheduleReport();
        } else {
          const gap = now - lastArrival;
          if (gap > maxGapMs) maxGapMs = gap;
          if (gap > 100) gapsOver100ms++;
        }
        lastArrival = now;
        received++;
      },
    },
  },
});

new Electroview({ rpc });
rpc.send.ready();
setStatus("waiting for ticks");
console.log("[spike-view] booted");
