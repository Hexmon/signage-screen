const { expect } = require('chai')
const {
  normalizeScheduleWindows,
  evaluateScheduleWindows,
} = require('../../../src/main/services/snapshot-evaluator.ts')

describe('Snapshot Evaluator', () => {
  it('normalizes published presentation slots into timed playback windows', () => {
    const windows = normalizeScheduleWindows(
      [
        {
          id: 'schedule-item-1',
          start_at: '2026-03-14T09:00:00.000Z',
          end_at: '2026-03-14T10:00:00.000Z',
          priority: 1,
          presentation: {
            id: 'presentation-1',
            name: 'Lobby Loop',
            layout: { id: 'layout-1', aspect_ratio: '16:9', spec: { slots: [] } },
            slots: [
              {
                id: 'slot-item-1',
                slot_id: 'main',
                media_id: 'media-1',
                order: 0,
                duration_seconds: 8,
                fit_mode: 'contain',
                audio_enabled: false,
                media: { id: 'media-1', name: 'Loop', type: 'IMAGE' },
              },
            ],
          },
        },
      ],
      {
        'media-1': 'https://cdn.example.com/loop.jpg',
      },
    )

    expect(windows).to.have.length(1)
    expect(windows[0].items).to.have.length(1)
    expect(windows[0].items[0].displayMs).to.equal(8000)
    expect(windows[0].items[0].remoteUrl).to.equal('https://cdn.example.com/loop.jpg')
  })

  it('maps pdf and document slot payloads to the correct playback types', () => {
    const windows = normalizeScheduleWindows(
      [
        {
          id: 'schedule-item-1',
          start_at: '2026-03-14T09:00:00.000Z',
          end_at: '2026-03-14T10:00:00.000Z',
          priority: 1,
          presentation: {
            id: 'presentation-1',
            name: 'Docs',
            layout: { id: 'layout-1', aspect_ratio: '16:9', spec: { slots: [] } },
            slots: [
              {
                id: 'slot-item-pdf',
                slot_id: 'main',
                media_id: 'media-pdf',
                order: 0,
                duration_seconds: 8,
                fit_mode: 'contain',
                audio_enabled: false,
                media: {
                  id: 'media-pdf',
                  name: 'Booklet',
                  type: 'DOCUMENT',
                  source_content_type: 'application/pdf',
                },
              },
              {
                id: 'slot-item-office',
                slot_id: 'main',
                media_id: 'media-office',
                order: 1,
                duration_seconds: 8,
                fit_mode: 'contain',
                audio_enabled: false,
                media: {
                  id: 'media-office',
                  name: 'Deck.pptx',
                  type: 'DOCUMENT',
                  source_content_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                },
              },
            ],
          },
        },
      ],
      {
        'media-pdf': 'https://cdn.example.com/booklet',
        'media-office': 'https://cdn.example.com/deck',
      },
    )

    expect(windows).to.have.length(1)
    expect(windows[0].items[0].type).to.equal('pdf')
    expect(windows[0].items[1].type).to.equal('office')
  })

  it('selects the highest priority active window and computes the next transition boundary', () => {
    const evaluation = evaluateScheduleWindows(
      [
        {
          id: 'window-1',
          startAt: '2026-03-14T09:00:00.000Z',
          endAt: '2026-03-14T10:00:00.000Z',
          priority: 1,
          items: [{ id: 'item-1', mediaId: 'media-1', remoteUrl: 'https://cdn.example.com/1.jpg', type: 'image', displayMs: 10000, fit: 'contain', muted: true, transitionDurationMs: 0 }],
        },
        {
          id: 'window-2',
          startAt: '2026-03-14T09:30:00.000Z',
          endAt: '2026-03-14T09:45:00.000Z',
          priority: 5,
          items: [{ id: 'item-2', mediaId: 'media-2', remoteUrl: 'https://cdn.example.com/2.jpg', type: 'image', displayMs: 10000, fit: 'contain', muted: true, transitionDurationMs: 0 }],
        },
      ],
      Date.parse('2026-03-14T09:35:00.000Z'),
    )

    expect(evaluation.activeWindow?.id).to.equal('window-2')
    expect(evaluation.items[0].mediaId).to.equal('media-2')
    expect(evaluation.nextTransitionAt).to.equal(Date.parse('2026-03-14T09:45:00.000Z'))
  })
})
