package com.imradexglobal.cooplogng.data

import android.content.Context
import android.graphics.Paint
import android.graphics.pdf.PdfDocument
import java.io.File
import java.text.NumberFormat
import java.util.Locale

object StatementPdfExporter {
    fun write(context: Context, session: MemberSession, snapshot: MemberSnapshot): File {
        val document = PdfDocument()
        val pageWidth = 595
        val pageHeight = 842
        val margin = 40f
        val titlePaint = Paint().apply { textSize = 20f; isFakeBoldText = true }
        val bodyPaint = Paint().apply { textSize = 10f }
        val mutedPaint = Paint().apply { textSize = 9f; color = 0xFF5F6368.toInt() }
        val money = NumberFormat.getCurrencyInstance(Locale("en", "NG"))
        var pageNumber = 1
        var page = document.startPage(PdfDocument.PageInfo.Builder(pageWidth, pageHeight, pageNumber).create())
        var y = margin

        fun newPage() {
            document.finishPage(page)
            pageNumber += 1
            page = document.startPage(PdfDocument.PageInfo.Builder(pageWidth, pageHeight, pageNumber).create())
            y = margin
        }
        fun line(text: String, paint: Paint = bodyPaint, gap: Float = 18f) {
            if (y > pageHeight - 55) newPage()
            page.canvas.drawText(text.take(100), margin, y, paint)
            y += gap
        }

        line("CoopLogNg Member Statement", titlePaint, 28f)
        line(session.cooperativeName, mutedPaint)
        line("Member: ${session.displayName} · ID: ${session.memberId}", mutedPaint, 28f)
        line("Approved account balances", bodyPaint)
        snapshot.accounts.forEach { account -> line("${account.name}: ${money.format(account.balance)}") }
        y += 10f
        line("Approved activity", bodyPaint)
        line("Date        Account                         Credit          Debit        Balance", mutedPaint)
        snapshot.recentTransactions.forEach { tx ->
            line("${tx.date.take(10).padEnd(12)} ${tx.accountName.take(28).padEnd(29)} ${money.format(tx.credit).padStart(14)} ${money.format(tx.debit).padStart(14)} ${money.format(tx.runningBalance).padStart(14)}", bodyPaint, 16f)
        }
        y += 10f
        line("Generated from the authenticated member snapshot. This document contains approved records returned by CoopLogNg.", mutedPaint, 14f)
        line("Generated: ${snapshot.refreshedAt}", mutedPaint)
        document.finishPage(page)

        val file = File(context.cacheDir, "cooplogng-statement-${session.memberId}.pdf")
        file.outputStream().use { document.writeTo(it) }
        document.close()
        return file
    }
}
