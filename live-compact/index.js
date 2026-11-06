import { Plugin } from "@opencode/plugin"
import { createLiveCompact } from "./hook.mjs"

export default Plugin.define({
  id: "live-compact",
  setup(ctx) {
    return createLiveCompact(ctx)
  },
})
