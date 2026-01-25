/**
 * Unit tests for media compatibility helper
 */

const { expect } = require('chai')
const {
  checkMediaCompatibility,
  getExtensionFromUrl,
  normalizeMime,
} = require('../../../src/common/media-compat.ts')

describe('Media Compatibility', () => {
  it('should allow image by extension', () => {
    const result = checkMediaCompatibility({ type: 'IMAGE', name: 'photo.jpg' })
    expect(result.status).to.equal('PLAYABLE_NOW')
    expect(result.kind).to.equal('IMAGE')
    expect(result.normalizedExt).to.equal('jpg')
  })

  it('should allow image by mime', () => {
    const result = checkMediaCompatibility({ type: 'IMAGE', source_content_type: 'image/png' })
    expect(result.status).to.equal('PLAYABLE_NOW')
    expect(result.kind).to.equal('IMAGE')
    expect(result.normalizedMime).to.equal('image/png')
  })

  it('should allow video by mime and extension', () => {
    const viaMime = checkMediaCompatibility({ type: 'VIDEO', source_content_type: 'video/quicktime' })
    expect(viaMime.status).to.equal('PLAYABLE_NOW')
    expect(viaMime.kind).to.equal('VIDEO')

    const viaExt = checkMediaCompatibility({ type: 'VIDEO', name: 'clip.mov' })
    expect(viaExt.status).to.equal('PLAYABLE_NOW')
    expect(viaExt.normalizedExt).to.equal('mov')
  })

  it('should allow pdf documents', () => {
    const result = checkMediaCompatibility({ type: 'DOCUMENT', name: 'brochure.pdf' })
    expect(result.status).to.equal('PLAYABLE_NOW')
    expect(result.kind).to.equal('DOCUMENT')
  })

  it('should mark office docs as accepted but not supported', () => {
    const docx = checkMediaCompatibility({ type: 'DOCUMENT', name: 'report.docx' })
    expect(docx.status).to.equal('ACCEPTED_BUT_NOT_SUPPORTED_YET')

    const pptx = checkMediaCompatibility({ type: 'DOCUMENT', source_content_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' })
    expect(pptx.status).to.equal('ACCEPTED_BUT_NOT_SUPPORTED_YET')

    const csv = checkMediaCompatibility({ type: 'DOCUMENT', source_content_type: 'text/csv' })
    expect(csv.status).to.equal('ACCEPTED_BUT_NOT_SUPPORTED_YET')
  })

  it('should reject unknown extensions', () => {
    const result = checkMediaCompatibility({ type: 'IMAGE', name: 'image.bmp' })
    expect(result.status).to.equal('REJECTED')
  })

  it('should work with mime when name missing', () => {
    const result = checkMediaCompatibility({ type: 'VIDEO', source_content_type: 'video/mp4' })
    expect(result.status).to.equal('PLAYABLE_NOW')
    expect(result.normalizedMime).to.equal('video/mp4')
  })

  it('should infer extension from signed URL with query params', () => {
    const url = 'https://cdn.example.com/media/file.mp4?X-Amz-Expires=3600'
    const ext = getExtensionFromUrl(url)
    expect(ext).to.equal('mp4')

    const result = checkMediaCompatibility({ type: 'VIDEO', media_url: url })
    expect(result.status).to.equal('PLAYABLE_NOW')
    expect(result.normalizedExt).to.equal('mp4')
  })

  it('should normalize mime values', () => {
    const normalized = normalizeMime('Image/PNG; charset=utf-8')
    expect(normalized).to.equal('image/png')
  })
})
