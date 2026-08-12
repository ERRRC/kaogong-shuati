"""
将 Markdown 格式的申论批改输出转换为 .docx 文件。

用法:
  python export_docx.py <input.md> <output.docx>
"""

import sys
import re
from pathlib import Path

try:
    from docx import Document
    from docx.shared import Pt, Inches, Cm, RGBColor
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml.ns import qn
    from docx.oxml import OxmlElement
except ImportError:
    print("需要安装 python-docx: pip install python-docx")
    sys.exit(1)


# 需要高亮突显的段落关键词（小马哥版、白鹭版参考作答内容）
HIGHLIGHT_TRIGGERS = ['小马哥版', '白鹭版', '袁东版']
HIGHLIGHT_BG = 'F2F7FB'  # 浅蓝色底


def set_cell_shading(cell, color):
    """设置单元格底色"""
    shading_elm = cell._element.get_or_add_tcPr()
    shading = shading_elm.makeelement(qn('w:shd'), {
        qn('w:fill'): color,
        qn('w:val'): 'clear',
    })
    shading_elm.append(shading)


def set_cell_vertical_align(cell, align='center'):
    """设置单元格垂直居中"""
    tc = cell._element
    tcPr = tc.get_or_add_tcPr()
    vAlign = OxmlElement('w:vAlign')
    vAlign.set(qn('w:val'), align)
    tcPr.append(vAlign)


def set_cell_width(cell, width):
    """设置单元格宽度"""
    tc = cell._element
    tcPr = tc.get_or_add_tcPr()
    tcW = OxmlElement('w:tcW')
    tcW.set(qn('w:w'), str(width))
    tcW.set(qn('w:type'), 'dxa')
    tcPr.append(tcW)


def estimate_col_widths(headers, rows):
    """根据表头和第一行数据估算列宽（dxa单位，1cm≈567dxa）"""
    n = len(headers)
    text_lens = []
    for j in range(n):
        max_len = len(headers[j])
        for row in rows[:3]:  # 只取前3行估算
            if j < len(row):
                max_len = max(max_len, len(row[j]))
        text_lens.append(max_len)

    # 总可用宽度约13cm（A4 21cm - 左右边距约4cm - 留白），即约7400 dxa
    total_width = 7400
    # 按字符数比例分配
    total_len = sum(text_lens) or 1
    widths = [max(int(total_width * l / total_len), 800) for l in text_lens]
    # 确保不超总宽
    factor = total_width / sum(widths)
    widths = [int(w * factor) for w in widths]
    return widths


def set_paragraph_shading(paragraph, color):
    """设置段落底色"""
    pPr = paragraph._element.get_or_add_pPr()
    shading = OxmlElement('w:shd')
    shading.set(qn('w:fill'), color)
    shading.set(qn('w:val'), 'clear')
    pPr.append(shading)


def add_markdown_table(doc, lines, start_idx):
    """解析 Markdown 表格并添加到 docx"""
    header_line = lines[start_idx]
    headers = [h.strip() for h in header_line.strip('|').split('|')]

    rows = []
    i = start_idx + 2
    while i < len(lines) and lines[i].strip().startswith('|'):
        row = [cell.strip() for cell in lines[i].strip('|').split('|')]
        rows.append(row)
        i += 1

    col_widths = estimate_col_widths(headers, rows)

    table = doc.add_table(rows=1 + len(rows), cols=len(headers))
    table.style = 'Table Grid'
    table.autofit = False

    # 表头 — 深蓝底白字，水平居中 + 垂直居中
    for j, header in enumerate(headers):
        cell = table.rows[0].cells[j]
        cell.text = ''
        p = cell.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_before = Pt(2)
        p.paragraph_format.space_after = Pt(2)
        run = p.add_run(header)
        run.bold = True
        run.font.size = Pt(10)
        set_cell_shading(cell, '2F5496')
        run.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
        set_cell_vertical_align(cell, 'center')
        set_cell_width(cell, col_widths[j])

    # 数据行 — 水平居中 + 垂直居中，字体略小
    for r, row in enumerate(rows):
        for c, val in enumerate(row):
            cell = table.rows[r + 1].cells[c]
            cell.text = ''
            p = cell.paragraphs[0]
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            p.paragraph_format.space_before = Pt(1)
            p.paragraph_format.space_after = Pt(1)
            run = p.add_run(val)
            run.font.size = Pt(9)
            set_cell_vertical_align(cell, 'center')
            set_cell_width(cell, col_widths[c])

    doc.add_paragraph()
    return i


def in_highlight_section(heading_text):
    """判断是否进入了需要高亮突显的参考作答区域"""
    return any(trigger in heading_text for trigger in HIGHLIGHT_TRIGGERS)


def convert_md_to_docx(input_path: str, output_path: str):
    doc = Document()

    # 设置默认字体 — 加大到 12pt
    style = doc.styles['Normal']
    font = style.font
    font.name = '宋体'
    font.size = Pt(12)
    style.element.rPr.rFonts.set(qn('w:eastAsia'), '宋体')
    # 设置段落间距
    style.paragraph_format.space_after = Pt(6)
    style.paragraph_format.line_spacing = 1.5

    # 设置页边距
    for section in doc.sections:
        section.top_margin = Cm(2.5)
        section.bottom_margin = Cm(2.5)
        section.left_margin = Cm(2.8)
        section.right_margin = Cm(2.8)

    with open(input_path, 'r', encoding='utf-8') as f:
        content = f.read()

    lines = content.split('\n')
    i = 0
    highlight_mode = False  # 是否处于参考作答高亮区域
    highlight_buffer = []   # 高亮区域内的段落缓存

    def flush_highlight_buffer():
        """输出缓存的高亮段落"""
        nonlocal highlight_buffer
        for p in highlight_buffer:
            set_paragraph_shading(p, HIGHLIGHT_BG)
        highlight_buffer = []

    while i < len(lines):
        line = lines[i]

        # 跳过空行
        if not line.strip():
            i += 1
            continue

        # 一级标题 #
        if line.startswith('# ') and not line.startswith('## '):
            if highlight_mode:
                flush_highlight_buffer()
                highlight_mode = False
            heading = doc.add_heading(line[2:].strip(), level=1)
            for run in heading.runs:
                run.font.name = '黑体'
                run._element.rPr.rFonts.set(qn('w:eastAsia'), '黑体')
                run.font.size = Pt(18)
            i += 1
            continue

        # 二级标题 ##
        if line.startswith('## '):
            if highlight_mode:
                flush_highlight_buffer()
                highlight_mode = False
            heading = doc.add_heading(line[3:].strip(), level=2)
            for run in heading.runs:
                run.font.name = '黑体'
                run._element.rPr.rFonts.set(qn('w:eastAsia'), '黑体')
                run.font.size = Pt(15)
            i += 1
            continue

        # 三级标题 ###
        if line.startswith('### '):
            if highlight_mode:
                flush_highlight_buffer()
                highlight_mode = False
            heading_text = line[4:].strip()
            heading = doc.add_heading(heading_text, level=3)
            for run in heading.runs:
                run.font.name = '黑体'
                run._element.rPr.rFonts.set(qn('w:eastAsia'), '黑体')
                run.font.size = Pt(13)
            # 检查是否进入高亮区域
            if in_highlight_section(heading_text):
                highlight_mode = True
            i += 1
            continue

        # Markdown 表格
        if line.strip().startswith('|'):
            if highlight_mode:
                flush_highlight_buffer()
                highlight_mode = False
            i = add_markdown_table(doc, lines, i)
            continue

        # 代码块
        if line.strip().startswith('```'):
            i += 1
            while i < len(lines) and not lines[i].strip().startswith('```'):
                i += 1
            i += 1
            continue

        # 分隔线
        if line.strip() == '---':
            if highlight_mode:
                flush_highlight_buffer()
                highlight_mode = False
            p = doc.add_paragraph('—' * 20)
            for run in p.runs:
                run.font.size = Pt(12)
            i += 1
            continue

        # 引用块 >
        if line.strip().startswith('>'):
            quote_text = line.strip()[1:].strip()
            p = doc.add_paragraph()
            run = p.add_run(quote_text)
            run.italic = True
            run.font.size = Pt(11)
            run.font.color.rgb = RGBColor(0x66, 0x66, 0x66)
            if highlight_mode:
                highlight_buffer.append(p)
            i += 1
            continue

        # 无序列表
        if line.strip().startswith('- ') or line.strip().startswith('* '):
            text = line.strip()[2:]
            text = re.sub(r'\*\*(.+?)\*\*', r'\1', text)
            p = doc.add_paragraph(text)
            p.style = doc.styles['List Bullet']
            if highlight_mode:
                highlight_buffer.append(p)
            i += 1
            continue

        # 有序列表 — 不依赖 Word 自动编号，直接写数字避免跨段连号
        if re.match(r'^\d+\.\s', line.strip()):
            text = re.sub(r'\*\*(.+?)\*\*', r'\1', line.strip())
            p = doc.add_paragraph(text)
            # 用缩进模拟列表样式
            p.paragraph_format.left_indent = Cm(1.5)
            p.paragraph_format.first_line_indent = Cm(-0.5)
            if highlight_mode:
                highlight_buffer.append(p)
            i += 1
            continue

        # 普通段落
        text = line.strip()
        # 处理粗体
        if '**' in text:
            p = doc.add_paragraph()
            parts = re.split(r'(\*\*.+?\*\*)', text)
            for part in parts:
                if part.startswith('**') and part.endswith('**'):
                    run = p.add_run(part[2:-2])
                    run.bold = True
                    run.font.size = Pt(12)
                else:
                    run = p.add_run(part)
                    run.font.size = Pt(12)
        else:
            p = doc.add_paragraph(text)

        if highlight_mode:
            highlight_buffer.append(p)

        i += 1

    # 处理最后的高亮缓存
    if highlight_mode:
        flush_highlight_buffer()

    doc.save(output_path)
    print(f"已导出: {output_path}")


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("用法: python export_docx.py <input.md> <output.docx>")
        sys.exit(1)

    convert_md_to_docx(sys.argv[1], sys.argv[2])
