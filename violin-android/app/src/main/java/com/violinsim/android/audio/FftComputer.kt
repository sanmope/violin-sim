package com.violinsim.android.audio

import com.violinsim.android.config.AudioConfig
import kotlin.math.*

class FftComputer {

    private val logEdges = DoubleArray(AudioConfig.N_FFT_BINS + 1).also { edges ->
        val logMin = log10(AudioConfig.FMIN)
        val logMax = log10(AudioConfig.FMAX)
        for (i in edges.indices) {
            edges[i] = 10.0.pow(logMin + i.toDouble() / AudioConfig.N_FFT_BINS * (logMax - logMin))
        }
    }

    fun computeLogSpacedFft(window: FloatArray): FloatArray {
        // Zero-pad to next power of 2
        val n = Integer.highestOneBit(window.size - 1) shl 1  // next power of 2
        val real = FloatArray(n)
        val imag = FloatArray(n)
        window.copyInto(real)

        // In-place Cooley-Tukey FFT
        fft(real, imag)

        // Magnitude of positive frequencies
        val nBins = n / 2 + 1
        val magnitude = FloatArray(nBins)
        for (k in 0 until nBins) {
            magnitude[k] = sqrt(real[k] * real[k] + imag[k] * imag[k])
        }
        val freqResolution = AudioConfig.SAMPLE_RATE.toDouble() / n

        // Bin into log-spaced buckets
        val binned = FloatArray(AudioConfig.N_FFT_BINS)
        for (i in 0 until AudioConfig.N_FFT_BINS) {
            val fLow = logEdges[i]
            val fHigh = logEdges[i + 1]
            var sum = 0.0
            var count = 0
            val kLow = max(0, (fLow / freqResolution).toInt())
            val kHigh = min(nBins - 1, (fHigh / freqResolution).toInt())
            for (k in kLow..kHigh) {
                val freq = k * freqResolution
                if (freq >= fLow && freq < fHigh) {
                    sum += magnitude[k]
                    count++
                }
            }
            if (count > 0) binned[i] = (sum / count).toFloat()
        }

        // Normalize to 0..1
        val mx = binned.max()
        if (mx > 1e-9f) {
            for (i in binned.indices) binned[i] /= mx
        }
        return binned
    }

    private fun fft(real: FloatArray, imag: FloatArray) {
        val n = real.size
        // Bit-reversal permutation
        var j = 0
        for (i in 1 until n) {
            var bit = n shr 1
            while (j and bit != 0) {
                j = j xor bit
                bit = bit shr 1
            }
            j = j xor bit
            if (i < j) {
                var tmp = real[i]; real[i] = real[j]; real[j] = tmp
                tmp = imag[i]; imag[i] = imag[j]; imag[j] = tmp
            }
        }
        // Butterfly
        var len = 2
        while (len <= n) {
            val halfLen = len / 2
            val angle = (-2.0 * PI / len).toFloat()
            val wReal = cos(angle)
            val wImag = sin(angle)
            var i = 0
            while (i < n) {
                var curReal = 1f
                var curImag = 0f
                for (k in 0 until halfLen) {
                    val tReal = curReal * real[i + k + halfLen] - curImag * imag[i + k + halfLen]
                    val tImag = curReal * imag[i + k + halfLen] + curImag * real[i + k + halfLen]
                    real[i + k + halfLen] = real[i + k] - tReal
                    imag[i + k + halfLen] = imag[i + k] - tImag
                    real[i + k] += tReal
                    imag[i + k] += tImag
                    val newReal = curReal * wReal - curImag * wImag
                    curImag = curReal * wImag + curImag * wReal
                    curReal = newReal
                }
                i += len
            }
            len = len shl 1
        }
    }
}
