import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectLadder, validateProbe } from "./lib/media-pipeline.js";

describe("selectLadder", () => {
  it("returns 1080/720/480 for HD+ sources", () => {
    assert.deepEqual(
      selectLadder(1080).map((rung) => ({ label: rung.label, height: rung.height })),
      [
        { label: "1080p", height: 1080 },
        { label: "720p", height: 720 },
        { label: "480p", height: 480 },
      ],
    );
    assert.deepEqual(
      selectLadder(2160).map((rung) => rung.label),
      ["1080p", "720p", "480p"],
    );
  });

  it("drops 1080p when source is 720p", () => {
    assert.deepEqual(
      selectLadder(720).map((rung) => ({ label: rung.label, height: rung.height })),
      [
        { label: "720p", height: 720 },
        { label: "480p", height: 480 },
      ],
    );
  });

  it("keeps a single capped rung for tiny sources", () => {
    const ladder = selectLadder(240);
    assert.equal(ladder.length, 1);
    assert.equal(ladder[0]?.label, "480p");
    assert.equal(ladder[0]?.height, 240);
  });
});

describe("validateProbe", () => {
  it("rejects sources without video", () => {
    assert.throws(() =>
      validateProbe("/tmp/x.mkv", {
        streams: [],
        format: { duration: "10" },
      }),
    );
  });

  it("accepts a minimal valid probe", () => {
    const source = validateProbe("/tmp/x.mkv", {
      streams: [
        {
          index: 0,
          codec_type: "video",
          codec_name: "h264",
          width: 1920,
          height: 1080,
          avg_frame_rate: "24/1",
        },
        {
          index: 1,
          codec_type: "audio",
          codec_name: "aac",
        },
      ],
      format: { duration: "120.5" },
    });
    assert.equal(source.height, 1080);
    assert.equal(source.hasAudio, true);
    assert.equal(source.durationSeconds, 120.5);
  });
});
