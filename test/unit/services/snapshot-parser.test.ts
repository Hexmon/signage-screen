/**
 * Unit tests for snapshot parsing
 */

const { expect } = require('chai')
const { parseSnapshotResponse } = require('../../../src/main/services/snapshot-parser.ts')

describe('Snapshot Parser', () => {
  it('should parse published snapshot with media URLs', () => {
    const raw = {
      id: 'snap-1',
      schedule: {
        id: 'sched-1',
        items: [
          {
            id: 'item-1',
            media_id: 'media-1',
            type: 'image',
            display_ms: 10000,
          },
        ],
      },
      media_urls: {
        'media-1': 'https://cdn.example.com/media-1.jpg',
      },
    }

    const parsed = parseSnapshotResponse(raw)

    expect(parsed.scheduleId).to.equal('sched-1')
    expect(parsed.items).to.have.length(1)
    expect(parsed.items[0].remoteUrl).to.equal('https://cdn.example.com/media-1.jpg')
  })

  it('should parse emergency media override', () => {
    const raw = {
      id: 'snap-2',
      emergency: {
        active: true,
        media_id: 'media-emergency',
        media_url: 'https://cdn.example.com/emergency.mp4',
        type: 'video',
        display_ms: 15000,
      },
    }

    const parsed = parseSnapshotResponse(raw)

    expect(parsed.emergencyItem).to.exist
    expect(parsed.emergencyItem?.mediaId).to.equal('media-emergency')
    expect(parsed.emergencyItem?.remoteUrl).to.equal('https://cdn.example.com/emergency.mp4')
  })

  it('should parse default media fallback', () => {
    const raw = {
      id: 'snap-3',
      default_media: {
        media_id: 'media-default',
        media_url: 'https://cdn.example.com/default.jpg',
        type: 'image',
        display_ms: 12000,
      },
    }

    const parsed = parseSnapshotResponse(raw)

    expect(parsed.defaultItem).to.exist
    expect(parsed.defaultItem?.mediaId).to.equal('media-default')
    expect(parsed.defaultItem?.remoteUrl).to.equal('https://cdn.example.com/default.jpg')
  })

  it('should treat converted default documents as pdf playback when content_type is pdf', () => {
    const raw = {
      id: 'snap-doc-default',
      default_media: {
        media_id: 'media-default-doc',
        media_url: 'https://cdn.example.com/converted.pdf',
        type: 'DOCUMENT',
        content_type: 'application/pdf',
        source_content_type: 'text/csv',
        display_ms: 12000,
      },
    }

    const parsed = parseSnapshotResponse(raw)

    expect(parsed.defaultItem).to.exist
    expect(parsed.defaultItem?.type).to.equal('pdf')
    expect(parsed.defaultItem?.meta?.content_type).to.equal('application/pdf')
    expect(parsed.defaultItem?.meta?.source_content_type).to.equal('text/csv')
  })

  it('should parse root-level default media from wrapped device snapshot responses', () => {
    const raw = {
      device_id: 'device-1',
      snapshot: {
        schedule: {
          id: 'sched-5',
          items: [],
        },
      },
      default_media: {
        media_id: 'media-default',
        media_url: 'https://cdn.example.com/default.jpg',
        type: 'image',
        display_ms: 12000,
      },
    }

    const parsed = parseSnapshotResponse(raw)

    expect(parsed.defaultItem).to.exist
    expect(parsed.defaultItem?.mediaId).to.equal('media-default')
    expect(parsed.defaultItem?.remoteUrl).to.equal('https://cdn.example.com/default.jpg')
  })

  it('should prefer live webpage URLs while keeping fallback preview metadata', () => {
    const raw = {
      id: 'snap-webpage-default',
      default_media: {
        media_id: 'media-webpage',
        media_url: 'https://cdn.example.com/webpage-fallback.svg',
        fallback_url: 'https://cdn.example.com/webpage-fallback.svg',
        source_url: 'https://status.example.com/dashboard',
        url: 'https://status.example.com/dashboard',
        type: 'url',
        display_ms: 12000,
      },
    }

    const parsed = parseSnapshotResponse(raw)

    expect(parsed.defaultItem).to.exist
    expect(parsed.defaultItem?.type).to.equal('url')
    expect(parsed.defaultItem?.remoteUrl).to.equal('https://status.example.com/dashboard')
    expect(parsed.defaultItem?.meta?.fallback_url).to.equal('https://cdn.example.com/webpage-fallback.svg')
    expect(parsed.defaultItem?.meta?.source_url).to.equal('https://status.example.com/dashboard')
  })

  it('should parse timed schedule windows from published snapshot payloads', () => {
    const raw = {
      snapshot_id: 'snap-4',
      schedule: {
        id: 'sched-4',
        timezone: 'Asia/Kolkata',
        items: [
          {
            id: 'schedule-item-1',
            start_at: '2026-03-14T09:00:00.000Z',
            end_at: '2026-03-14T10:00:00.000Z',
            priority: 5,
            presentation: {
              id: 'presentation-1',
              name: 'Lobby Morning',
              layout: {
                id: 'layout-1',
                aspect_ratio: '16:9',
                spec: { slots: [{ id: 'main', x: 0, y: 0, w: 1, h: 1 }] },
              },
              slots: [
                {
                  id: 'slot-item-1',
                  slot_id: 'main',
                  media_id: 'media-slot-1',
                  order: 0,
                  duration_seconds: 12,
                  fit_mode: 'cover',
                  audio_enabled: false,
                  loop_enabled: true,
                  media: {
                    id: 'media-slot-1',
                    name: 'Lobby Loop',
                    type: 'VIDEO',
                  },
                },
              ],
            },
          },
        ],
      },
      media_urls: {
        'media-slot-1': 'https://cdn.example.com/lobby-loop.mp4',
      },
    }

    const parsed = parseSnapshotResponse(raw)

    expect(parsed.snapshotId).to.equal('snap-4')
    expect(parsed.scheduleTimezone).to.equal('Asia/Kolkata')
    expect(parsed.items).to.have.length(0)
    expect(parsed.scheduleWindows).to.have.length(1)
    expect(parsed.scheduleWindows[0].priority).to.equal(5)
    expect(parsed.scheduleWindows[0].items[0].remoteUrl).to.equal('https://cdn.example.com/lobby-loop.mp4')
    expect(parsed.scheduleWindows[0].items[0].fit).to.equal('cover')
    expect(parsed.scheduleWindows[0].items[0].loop).to.equal(true)
  })

  it('should parse converted scheduled documents as pdf playback items', () => {
    const raw = {
      snapshot_id: 'snap-8',
      schedule: {
        id: 'sched-8',
        items: [
          {
            id: 'schedule-item-1',
            start_at: '2026-03-18T14:12:00.000Z',
            end_at: '2026-03-18T15:12:00.000Z',
            priority: 2,
            presentation: {
              id: 'presentation-1',
              name: 'Converted docs',
              items: [
                {
                  id: 'presentation-item-1',
                  media_id: 'media-1',
                  order: 0,
                  duration_seconds: 15,
                  media: {
                    id: 'media-1',
                    name: 'report.csv',
                    type: 'DOCUMENT',
                    content_type: 'application/pdf',
                    source_content_type: 'text/csv',
                  },
                },
              ],
            },
          },
        ],
      },
      media_urls: {
        'media-1': 'https://cdn.example.com/converted.pdf',
      },
    }

    const parsed = parseSnapshotResponse(raw)

    expect(parsed.scheduleWindows).to.have.length(1)
    expect(parsed.scheduleWindows[0].items).to.have.length(1)
    expect(parsed.scheduleWindows[0].items[0].type).to.equal('pdf')
    expect(parsed.scheduleWindows[0].items[0].meta?.content_type).to.equal('application/pdf')
    expect(parsed.scheduleWindows[0].items[0].meta?.source_content_type).to.equal('text/csv')
  })

  it('should not misread timed layout windows as direct playlist items', () => {
    const raw = {
      snapshot_id: 'snap-6',
      schedule: {
        id: 'sched-6',
        items: [
          {
            id: 'schedule-item-1',
            start_at: '2026-03-18T14:12:00.000Z',
            end_at: '2026-03-18T15:12:00.000Z',
            priority: 2,
            presentation: {
              id: 'presentation-1',
              name: 'Layout scene',
              layout: {
                id: 'layout-1',
                aspect_ratio: '16:9',
                spec: { slots: [{ id: 'slot-1', x: 0, y: 0, w: 1, h: 1 }] },
              },
              slots: [
                {
                  id: 'slot-item-1',
                  slot_id: 'slot-1',
                  media_id: 'media-1',
                  order: 0,
                  duration_seconds: 15,
                  fit_mode: 'cover',
                  audio_enabled: true,
                  media: {
                    id: 'media-1',
                    name: 'Loop',
                    type: 'VIDEO',
                  },
                },
              ],
            },
          },
        ],
      },
      media_urls: {
        'media-1': 'https://cdn.example.com/loop.mp4',
      },
    }

    const parsed = parseSnapshotResponse(raw)

    expect(parsed.items).to.deep.equal([])
    expect(parsed.scheduleWindows).to.have.length(1)
    expect(parsed.scheduleWindows[0].items).to.have.length(1)
    expect(parsed.scheduleWindows[0].items[0].mediaId).to.equal('media-1')
  })

  it('should read media_urls from wrapped device snapshot responses', () => {
    const raw = {
      device_id: 'device-1',
      snapshot: {
        schedule: {
          id: 'sched-7',
          items: [
            {
              id: 'schedule-item-1',
              start_at: '2026-03-18T14:12:00.000Z',
              end_at: '2026-03-18T15:12:00.000Z',
              priority: 2,
              presentation: {
                id: 'presentation-1',
                name: 'Layout scene',
                layout: {
                  id: 'layout-1',
                  aspect_ratio: '16:9',
                  spec: { slots: [{ id: 'slot-1', x: 0, y: 0, w: 1, h: 1 }] },
                },
                slots: [
                  {
                    id: 'slot-item-1',
                    slot_id: 'slot-1',
                    media_id: 'media-1',
                    order: 0,
                    duration_seconds: 15,
                    fit_mode: 'cover',
                    audio_enabled: true,
                    media: {
                      id: 'media-1',
                      name: 'Loop',
                      type: 'VIDEO',
                    },
                  },
                ],
              },
            },
          ],
        },
      },
      media_urls: {
        'media-1': 'https://cdn.example.com/loop.mp4',
      },
    }

    const parsed = parseSnapshotResponse(raw)

    expect(parsed.scheduleWindows).to.have.length(1)
    expect(parsed.scheduleWindows[0].items).to.have.length(1)
    expect(parsed.scheduleWindows[0].items[0].remoteUrl).to.equal('https://cdn.example.com/loop.mp4')
  })

  it('should parse webpage schedule items as live URL playback with fallback preview metadata', () => {
    const raw = {
      snapshot_id: 'snap-webpage-window',
      schedule: {
        id: 'sched-webpage',
        items: [
          {
            id: 'schedule-item-webpage',
            start_at: '2026-03-18T14:12:00.000Z',
            end_at: '2026-03-18T15:12:00.000Z',
            priority: 2,
            presentation: {
              id: 'presentation-webpage',
              name: 'Webpage scene',
              layout: {
                id: 'layout-1',
                aspect_ratio: '16:9',
                spec: { slots: [{ id: 'slot-1', x: 0, y: 0, w: 1, h: 1 }] },
              },
              slots: [
                {
                  id: 'slot-item-webpage',
                  slot_id: 'slot-1',
                  media_id: 'media-webpage',
                  order: 0,
                  duration_seconds: 15,
                  fit_mode: 'contain',
                  audio_enabled: false,
                  media: {
                    id: 'media-webpage',
                    name: 'KPI board',
                    type: 'WEBPAGE',
                    source_url: 'https://status.example.com/kpi',
                    fallback_url: 'https://cdn.example.com/kpi-fallback.svg',
                    url: 'https://status.example.com/kpi',
                  },
                },
              ],
            },
          },
        ],
      },
      media_urls: {
        'media-webpage': 'https://status.example.com/kpi',
      },
    }

    const parsed = parseSnapshotResponse(raw)

    expect(parsed.scheduleWindows).to.have.length(1)
    expect(parsed.scheduleWindows[0].items).to.have.length(1)
    expect(parsed.scheduleWindows[0].items[0].type).to.equal('url')
    expect(parsed.scheduleWindows[0].items[0].remoteUrl).to.equal('https://status.example.com/kpi')
    expect(parsed.scheduleWindows[0].items[0].meta?.fallback_url).to.equal('https://cdn.example.com/kpi-fallback.svg')
  })

  it('should keep scheduled webpage items as url when fallback metadata looks like an image', () => {
    const raw = {
      snapshot_id: 'snap-webpage-fallback-image',
      schedule: {
        id: 'sched-webpage-fallback-image',
        items: [
          {
            id: 'schedule-item-webpage-fallback-image',
            start_at: '2026-03-18T14:12:00.000Z',
            end_at: '2026-03-18T15:12:00.000Z',
            priority: 2,
            presentation: {
              id: 'presentation-webpage-fallback-image',
              name: 'Webpage with generated fallback',
              items: [
                {
                  id: 'presentation-item-webpage',
                  media_id: 'media-webpage-fallback-image',
                  order: 0,
                  duration_seconds: 15,
                  media: {
                    id: 'media-webpage-fallback-image',
                    name: 'Ops dashboard',
                    type: 'WEBPAGE',
                    content_type: 'image/svg+xml',
                    source_content_type: 'text/html',
                    source_url: 'http://localhost:8080/',
                    fallback_url: 'https://cdn.example.com/webpage-fallback.svg',
                    url: 'http://localhost:8080/',
                  },
                },
              ],
            },
          },
        ],
      },
      media_urls: {
        'media-webpage-fallback-image': 'http://localhost:8080/',
      },
    }

    const parsed = parseSnapshotResponse(raw)

    expect(parsed.scheduleWindows).to.have.length(1)
    expect(parsed.scheduleWindows[0].items).to.have.length(1)
    expect(parsed.scheduleWindows[0].items[0].type).to.equal('url')
    expect(parsed.scheduleWindows[0].items[0].remoteUrl).to.equal('http://localhost:8080/')
    expect(parsed.scheduleWindows[0].items[0].meta?.fallback_url).to.equal('https://cdn.example.com/webpage-fallback.svg')
    expect(parsed.scheduleWindows[0].items[0].meta?.content_type).to.equal('image/svg+xml')
    expect(parsed.scheduleWindows[0].items[0].meta?.source_content_type).to.equal('text/html')
  })

  it('should ignore expired emergency overrides', () => {
    const raw = {
      id: 'snap-5',
      emergency: {
        active: true,
        expires_at: '2026-03-10T00:00:00.000Z',
        media_id: 'media-expired',
        media_url: 'https://cdn.example.com/expired.mp4',
        type: 'video',
      },
    }

    const parsed = parseSnapshotResponse(raw)

    expect(parsed.emergencyItem).to.equal(undefined)
  })
})
