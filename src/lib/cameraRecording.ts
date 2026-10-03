/** Record the existing local restream even when the dashboard displays stills. */
export async function recordCameraClip(server: string, cameraId: string): Promise<Blob> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(`${server.trim().replace(/\/+$/, '')}/cameras/${encodeURIComponent(cameraId)}/record`, {
      method: 'POST', mode: 'cors', cache: 'no-store', signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 404) throw new Error('Emergency recording is unavailable. Restart the local camera service after updating it.');
      throw new Error(`Could not record emergency clip (HTTP ${response.status}).`);
    }
    const blob = await response.blob();
    if (!blob.size || !blob.type.startsWith('video/mp4')) throw new Error('The camera service did not return a video recording.');
    return blob;
  } finally { window.clearTimeout(timeout); }
}
