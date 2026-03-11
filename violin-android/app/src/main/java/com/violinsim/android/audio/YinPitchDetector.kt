package com.violinsim.android.audio

import kotlin.math.sqrt

data class PitchResult(val pitchHz: Float, val confidence: Float)

class YinPitchDetector(
    private val sampleRate: Int,
    private val bufferSize: Int,
    private val threshold: Float = 0.7f
) {
    private val halfBuffer = bufferSize / 2
    private val yinBuffer = FloatArray(halfBuffer)

    fun detect(buffer: FloatArray): PitchResult {
        // Step 1: Difference function
        for (tau in 0 until halfBuffer) {
            yinBuffer[tau] = 0f
            for (j in 0 until halfBuffer) {
                val delta = buffer[j] - buffer[j + tau]
                yinBuffer[tau] += delta * delta
            }
        }

        // Step 2: Cumulative mean normalized difference
        yinBuffer[0] = 1f
        var runningSum = 0f
        for (tau in 1 until halfBuffer) {
            runningSum += yinBuffer[tau]
            yinBuffer[tau] = if (runningSum > 0f) {
                yinBuffer[tau] * tau / runningSum
            } else {
                1f
            }
        }

        // Step 3: Absolute threshold — find first valley below threshold
        var tauEstimate = -1
        for (tau in 2 until halfBuffer) {
            if (yinBuffer[tau] < threshold) {
                // Find the local minimum from here
                while (tau + 1 < halfBuffer && yinBuffer[tau + 1] < yinBuffer[tau]) {
                    tauEstimate = tau + 1
                    break
                }
                if (tauEstimate < 0) tauEstimate = tau
                break
            }
        }

        if (tauEstimate < 0) {
            return PitchResult(0f, 0f)
        }

        // Step 4: Parabolic interpolation
        val betterTau = parabolicInterp(tauEstimate)
        val confidence = 1f - yinBuffer[tauEstimate]
        val pitch = sampleRate.toFloat() / betterTau

        return PitchResult(pitch, confidence)
    }

    private fun parabolicInterp(tau: Int): Float {
        if (tau < 1 || tau >= halfBuffer - 1) return tau.toFloat()
        val s0 = yinBuffer[tau - 1]
        val s1 = yinBuffer[tau]
        val s2 = yinBuffer[tau + 1]
        val denom = 2f * (2f * s1 - s2 - s0)
        return if (denom != 0f) {
            tau + (s0 - s2) / denom
        } else {
            tau.toFloat()
        }
    }
}
