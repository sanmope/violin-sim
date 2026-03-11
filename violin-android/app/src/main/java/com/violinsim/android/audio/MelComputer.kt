package com.violinsim.android.audio

import com.violinsim.android.config.AudioConfig
import kotlin.math.*

class MelComputer {

    private val nFft = AudioConfig.MEL_NPERSEG
    private val nMels = AudioConfig.N_MEL_BINS
    private val nBins = nFft / 2 + 1  // 257
    private val filterbank: Array<FloatArray> = buildFilterbank()

    // Pre-computed Hann window
    private val hannWindow = FloatArray(nFft) { i ->
        (0.5 * (1 - cos(2.0 * PI * i / nFft))).toFloat()
    }

    private fun hzToMel(hz: Double) = 2595.0 * log10(1.0 + hz / 700.0)
    private fun melToHz(mel: Double) = 700.0 * (10.0.pow(mel / 2595.0) - 1.0)

    private fun buildFilterbank(): Array<FloatArray> {
        val melPoints = DoubleArray(nMels + 2) { i ->
            val melMin = hzToMel(AudioConfig.FMIN)
            val melMax = hzToMel(AudioConfig.FMAX)
            melMin + i.toDouble() / (nMels + 1) * (melMax - melMin)
        }
        val hzPoints = DoubleArray(melPoints.size) { melToHz(melPoints[it]) }
        val binPoints = IntArray(hzPoints.size) { floor((nFft + 1) * hzPoints[it] / AudioConfig.SAMPLE_RATE).toInt() }

        return Array(nMels) { m ->
            val fb = FloatArray(nBins)
            val fl = binPoints[m]
            val fc = binPoints[m + 1]
            val fr = binPoints[m + 2]
            for (k in fl until fc) {
                if (fc != fl) fb[k] = (k - fl).toFloat() / (fc - fl)
            }
            for (k in fc until fr) {
                if (fr != fc) fb[k] = (fr - k).toFloat() / (fr - fc)
            }
            fb
        }
    }

    fun compute(window: FloatArray): FloatArray {
        // Compute spectrogram: segment window into overlapping frames
        val hop = AudioConfig.MEL_NOVERLAP  // 256 hop = noverlap
        val nFrames = max(1, (window.size - nFft) / hop + 1)

        // Power spectrogram: Sxx[freq_bin][frame]
        val sxx = Array(nBins) { FloatArray(nFrames) }
        val frameReal = FloatArray(8192)  // padded to next power of 2
        val frameImag = FloatArray(8192)
        val nPadded = 512  // nperseg=512, next power of 2 = 512

        for (f in 0 until nFrames) {
            val offset = f * hop
            // Clear arrays
            frameReal.fill(0f)
            frameImag.fill(0f)
            // Apply Hann window
            val copyLen = min(nFft, window.size - offset)
            for (i in 0 until copyLen) {
                frameReal[i] = window[offset + i] * hannWindow[i]
            }
            // FFT (in-place, power of 2 = 512)
            fft512(frameReal, frameImag)
            // Magnitude squared
            for (k in 0 until nBins) {
                sxx[k][f] = frameReal[k] * frameReal[k] + frameImag[k] * frameImag[k]
            }
        }

        // Apply mel filterbank: mel[m] = mean over frames of (filterbank[m] @ Sxx[:, frame])
        val melResult = FloatArray(nMels)
        for (m in 0 until nMels) {
            var sum = 0.0
            for (f in 0 until nFrames) {
                var dot = 0f
                for (k in 0 until nBins) {
                    dot += filterbank[m][k] * sxx[k][f]
                }
                sum += dot
            }
            melResult[m] = (sum / nFrames).toFloat()
        }

        // Convert to dB and normalize
        var minDb = Float.MAX_VALUE
        var maxDb = Float.MIN_VALUE
        for (m in 0 until nMels) {
            melResult[m] = (10.0 * log10(melResult[m].toDouble() + 1e-9)).toFloat()
            if (melResult[m] < minDb) minDb = melResult[m]
            if (melResult[m] > maxDb) maxDb = melResult[m]
        }
        val range = maxDb - minDb + 1e-6f
        for (m in 0 until nMels) {
            melResult[m] = (melResult[m] - minDb) / range
        }

        return melResult
    }

    // Specialized 512-point FFT (512 = 2^9)
    private fun fft512(real: FloatArray, imag: FloatArray) {
        val n = 512
        // Bit-reversal
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
