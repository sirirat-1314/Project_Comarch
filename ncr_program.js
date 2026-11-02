// CPU Pipeline Hazard Fighter - ด่านหลัก: nCr = n! / (r! * (n-r)!)
// ค่าเริ่มต้น n=5, r=2  -> ผลลัพธ์ที่ถูกต้อง $v0 = 10
//
// ข้อตกลงของฟิลด์ (ตรงกับ MIPS encoding):
//  - R-type : rs, rt = แหล่งข้อมูล, rd = ปลายทาง
//  - I-type (addi, lw) : rs = แหล่งข้อมูล, rt = ปลายทาง
//  - I-type (sw, beq)  : rs, rt = แหล่งข้อมูลทั้งคู่ (ไม่มีปลายทางที่เป็นรีจิสเตอร์)
//  - reads / writes : รายการรีจิสเตอร์ที่อ่าน/เขียนจริง (ใช้ตรวจ Data Hazard ในเกมได้ตรง ๆ)
//  - target : id ของคำสั่งปลายทางสำหรับ beq / j
//  - hazard : เฉลยสำหรับให้ระบบเกมตรวจคำตอบ (RAW, LOAD_USE, CONTROL)

// เนื้อหาหน้า Pre-game Tutorial: แยกเป็นข้อมูลกลางเพื่อให้ UI อื่นนำไปใช้ได้
// (ตัวเกมยังใช้ nCrProgram และ nCrExpected เหมือนเดิม)
const PIPELINE_TUTORIAL = [
  { id: 'mips', title: 'พื้นฐาน MIPS', citation: 'COA Notes บทที่ 2: MIPS registers และคำสั่งพื้นฐาน' },
  { id: 'stages', title: '5-Stage Pipeline', citation: 'COA Notes บทที่ 5, หน้า 117-120' },
  { id: 'hazards', title: 'Pipeline Hazards', citation: 'COA Notes บทที่ 5.1, หน้า 121-129' },
];

const nCrProgram = [
  // ---------- Setup ----------
  { id: 1,  label: null,    assembly: "addi $a0, $zero, 5",  rs: "zero", rt: "a0", rd: null, type: "I", reads: ["zero"],       writes: ["a0"], hazard: null },
  { id: 2,  label: null,    assembly: "addi $a1, $zero, 2",  rs: "zero", rt: "a1", rd: null, type: "I", reads: ["zero"],       writes: ["a1"], hazard: null },
  { id: 3,  label: null,    assembly: "sub $s0, $a0, $a1",   rs: "a0",   rt: "a1", rd: "s0", type: "R", reads: ["a0", "a1"],   writes: ["s0"], hazard: "RAW: a1 จากคำสั่ง 2 (ห่าง 1), a0 จากคำสั่ง 1 (ห่าง 2)" },

  // ---------- n! -> $s1 ----------
  { id: 4,  label: null,    assembly: "addi $s1, $zero, 1",  rs: "zero", rt: "s1", rd: null, type: "I", reads: ["zero"],       writes: ["s1"], hazard: null },
  { id: 5,  label: null,    assembly: "add $t0, $zero, $a0", rs: "zero", rt: "a0", rd: "t0", type: "R", reads: ["zero", "a0"], writes: ["t0"], hazard: null },
  { id: 6,  label: "loopN", assembly: "beq $t0, $zero, doneN", rs: "t0", rt: "zero", rd: null, type: "I", reads: ["t0", "zero"], writes: [], target: 10, hazard: "CONTROL + RAW: t0 จากคำสั่ง 5 (รอบแรก) / คำสั่ง 8 (รอบถัดไป)" },
  { id: 7,  label: null,    assembly: "mul $s1, $s1, $t0",   rs: "s1",   rt: "t0", rd: "s1", type: "R", reads: ["s1", "t0"],   writes: ["s1"], hazard: "RAW: s1 ที่ตัวเองเขียนไว้รอบก่อน" },
  { id: 8,  label: null,    assembly: "addi $t0, $t0, -1",   rs: "t0",   rt: "t0", rd: null, type: "I", reads: ["t0"],         writes: ["t0"], hazard: null },
  { id: 9,  label: null,    assembly: "j loopN",             rs: null,   rt: null, rd: null, type: "J", reads: [],             writes: [],     target: 6, hazard: "CONTROL: jump ทุกรอบ" },

  // ---------- r! -> $s2 ----------
  { id: 10, label: "doneN", assembly: "addi $s2, $zero, 1",  rs: "zero", rt: "s2", rd: null, type: "I", reads: ["zero"],       writes: ["s2"], hazard: null },
  { id: 11, label: null,    assembly: "add $t0, $zero, $a1", rs: "zero", rt: "a1", rd: "t0", type: "R", reads: ["zero", "a1"], writes: ["t0"], hazard: null },
  { id: 12, label: "loopR", assembly: "beq $t0, $zero, doneR", rs: "t0", rt: "zero", rd: null, type: "I", reads: ["t0", "zero"], writes: [], target: 16, hazard: "CONTROL + RAW: t0 จากคำสั่ง 11 / คำสั่ง 14" },
  { id: 13, label: null,    assembly: "mul $s2, $s2, $t0",   rs: "s2",   rt: "t0", rd: "s2", type: "R", reads: ["s2", "t0"],   writes: ["s2"], hazard: "RAW: s2 ที่ตัวเองเขียนไว้รอบก่อน" },
  { id: 14, label: null,    assembly: "addi $t0, $t0, -1",   rs: "t0",   rt: "t0", rd: null, type: "I", reads: ["t0"],         writes: ["t0"], hazard: null },
  { id: 15, label: null,    assembly: "j loopR",             rs: null,   rt: null, rd: null, type: "J", reads: [],             writes: [],     target: 12, hazard: "CONTROL: jump ทุกรอบ" },

  // ---------- (n-r)! -> $s3 ----------
  { id: 16, label: "doneR", assembly: "addi $s3, $zero, 1",  rs: "zero", rt: "s3", rd: null, type: "I", reads: ["zero"],       writes: ["s3"], hazard: null },
  { id: 17, label: null,    assembly: "add $t0, $zero, $s0", rs: "zero", rt: "s0", rd: "t0", type: "R", reads: ["zero", "s0"], writes: ["t0"], hazard: null },
  { id: 18, label: "loopS", assembly: "beq $t0, $zero, doneS", rs: "t0", rt: "zero", rd: null, type: "I", reads: ["t0", "zero"], writes: [], target: 22, hazard: "CONTROL + RAW: t0 จากคำสั่ง 17 / คำสั่ง 20" },
  { id: 19, label: null,    assembly: "mul $s3, $s3, $t0",   rs: "s3",   rt: "t0", rd: "s3", type: "R", reads: ["s3", "t0"],   writes: ["s3"], hazard: "RAW: s3 ที่ตัวเองเขียนไว้รอบก่อน" },
  { id: 20, label: null,    assembly: "addi $t0, $t0, -1",   rs: "t0",   rt: "t0", rd: null, type: "I", reads: ["t0"],         writes: ["t0"], hazard: null },
  { id: 21, label: null,    assembly: "j loopS",             rs: null,   rt: null, rd: null, type: "J", reads: [],             writes: [],     target: 18, hazard: "CONTROL: jump ทุกรอบ" },

  // ---------- รวมผล: nCr = n! / (r! * (n-r)!) ----------
  { id: 22, label: "doneS", assembly: "mul $t1, $s2, $s3",   rs: "s2",   rt: "s3", rd: "t1", type: "R", reads: ["s2", "s3"],   writes: ["t1"], hazard: "RAW: s3 จากคำสั่ง 16/19 (ห่างมาก ปกติปลอดภัย)" },
  { id: 23, label: null,    assembly: "div $s1, $t1",        rs: "s1",   rt: "t1", rd: null, type: "R", reads: ["s1", "t1"],   writes: ["LO", "HI"], hazard: "RAW: t1 จากคำสั่ง 22 (ห่าง 1)" },
  { id: 24, label: null,    assembly: "mflo $v0",            rs: null,   rt: null, rd: "v0", type: "R", reads: ["LO"],         writes: ["v0"], hazard: "RAW: LO จากคำสั่ง 23 (ห่าง 1)" },
  { id: 25, label: null,    assembly: "sw $v0, 0($sp)",      rs: "sp",   rt: "v0", rd: null, type: "I", reads: ["sp", "v0"],   writes: [],     hazard: "RAW: v0 จากคำสั่ง 24 (ห่าง 1)" },
  { id: 26, label: null,    assembly: "lw $t2, 0($sp)",      rs: "sp",   rt: "t2", rd: null, type: "I", reads: ["sp"],         writes: ["t2"], hazard: null },
  { id: 27, label: null,    assembly: "add $a2, $t2, $zero", rs: "t2",   rt: "zero", rd: "a2", type: "R", reads: ["t2", "zero"], writes: ["a2"], hazard: "LOAD_USE: ใช้ t2 ทันทีหลัง lw (ต้อง stall 1 รอบแม้มี forwarding)" },
  { id: 28, label: "end",   assembly: "j end",               rs: null,   rt: null, rd: null, type: "J", reads: [],             writes: [],     target: 28, hazard: "CONTROL: จุดจบโปรแกรม (วนอยู่ที่เดิม)" },
];

// ผลลัพธ์ที่คาดหวังเมื่อรันจนจบ (ใช้เช็คความถูกต้องของ simulator)
const nCrExpected = { a0: 5, a1: 2, s0: 3, s1: 120, s2: 2, s3: 6, t1: 12, v0: 10, a2: 10 };
