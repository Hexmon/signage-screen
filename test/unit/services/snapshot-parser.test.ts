/**
 * Unit tests for snapshot parsing
 */

import { expect } from 'chai'
import { parseSnapshotResponse } from '../../../src/main/services/snapshot-parser'

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
})
