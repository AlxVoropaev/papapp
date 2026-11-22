function createWatchTimer() {
  let previous;
  let watched = 0;
  return {
    sample(player) {
      if (watched > 60 || typeof player.getCurrentTime !== 'function' ||
          typeof player.getPlaybackRate !== 'function') return false;
      const current = {
        time: performance.now() / 1000,
        position: player.getCurrentTime(),
        rate: player.getPlaybackRate()
      };
      const prior = previous;
      previous = current;
      if (!prior || current.rate !== prior.rate || current.rate <= 0) return false;
      const elapsed = current.time - prior.time;
      const progressed = (current.position - prior.position) / prior.rate;
      // Large gaps and jumps across the timeline provide no evidence of playback.
      if (elapsed > 1.5 || progressed <= 0 || progressed > elapsed + 0.15) return false;
      watched += Math.min(elapsed, progressed);
      return watched > 60;
    },
    interrupt() {
      previous = undefined;
    }
  };
}
