package com.violinsim.android.audio

import com.violinsim.android.config.AudioConfig
import kotlin.math.sqrt

data class ProcessedFrame(
    val ts: Long,
    val pitch: Float,
    val mel: FloatArray,
    val fft: FloatArray,
    val rawChunk: FloatArray
)

class AudioProcessor {
    private val ringBuffer = FloatArray(AudioConfig.LOCAL_WINDOW)
    private val yinDetector = YinPitchDetector(
        AudioConfig.SAMPLE_RATE,
        AudioConfig.BUFFER_SIZE,
        AudioConfig.CONFIDENCE_THRESHOLD
    )
    private val melComputer = MelComputer()
    private val fftComputer = FftComputer()

    fun process(chunk: FloatArray): ProcessedFrame? {
        // RMS noise gate
        var sumSq = 0.0
        for (s in chunk) sumSq += s * s
        val rms = sqrt(sumSq / chunk.size).toFloat()
        if (rms < AudioConfig.RMS_THRESHOLD) return null

        // YIN pitch detection
        val pitchResult = yinDetector.detect(chunk)
        val pitch = if (pitchResult.confidence >= AudioConfig.CONFIDENCE_THRESHOLD) {
            pitchResult.pitchHz
        } else {
            0f
        }

        // Update ring buffer: shift left, append new chunk
        val n = chunk.size
        System.arraycopy(ringBuffer, n, ringBuffer, 0, ringBuffer.size - n)
        System.arraycopy(chunk, 0, ringBuffer, ringBuffer.size - n, n)

        // Compute mel and FFT on ring buffer
        val mel = melComputer.compute(ringBuffer)
        val fft = fftComputer.computeLogSpacedFft(ringBuffer)

        return ProcessedFrame(
            ts = System.currentTimeMillis(),
            pitch = pitch,
            mel = mel,
            fft = fft,
            rawChunk = chunk
        )
    }
}
