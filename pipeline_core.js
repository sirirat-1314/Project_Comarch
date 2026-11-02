/* =====================================================================
 * CPU Pipeline Hazard Fighter — Core Logic (MIPS 5-Stage Pipeline)
 * ---------------------------------------------------------------------
 * ใช้คู่กับ nCrProgram จาก ncr_program.js:
 *
 *   const sim = new PipelineSimulator(nCrProgram);
 *   sim.checkHazard();     // ดูว่าตอนนี้มี Hazard อะไรบ้าง
 *   sim.insertStall();     // ผู้เล่นกดปุ่ม "แทรก NOP"
 *   sim.enableForwarding();// ผู้เล่นกดปุ่ม "เปิดสายลัด"
 *   sim.nextCycle();       // เดินหน้า 1 clock
 *
 * แนวคิดสำคัญ
 *  - Simulator "รันคำสั่งจริง" (มี register file / memory / LO / HI) ไม่ใช่แค่แอนิเมชัน
 *    ดังนั้นถ้าผู้เล่นปล่อย Hazard ผ่านไป ค่าจะผิดจริง (stale read) และผลลัพธ์ nCr เพี้ยนจริง
 *  - Register file เขียนครึ่งแรกของ cycle / อ่านครึ่งหลัง  => producer ที่อยู่ WB ไม่ชน ID
 *    ดังนั้น Data Hazard เกิดเมื่อ producer อยู่ที่ EX หรือ MEM ขณะที่ consumer อยู่ ID
 *  - Forwarding ต่อเข้า "อินพุตของ EX" จาก 2 สาย: EX/MEM (producer อยู่ MEM) และ MEM/WB (producer อยู่ WB)
 *    ถ้า producer เป็น lw ที่ยังอยู่ EX ข้อมูลยังไม่ออกจาก memory => forward ไม่ทัน ต้อง stall 1 รอบ (Load-Use)
 *  - Control Hazard: Predict Not Taken (fetch คำสั่งถัดไปเสมอ) + ย้ายการตัดสิน branch มาที่ ID
 *    (ตามสไลด์ Pipelining หน้า 14-17, 59-61 และ COA Notes 5.1.3)
 *      j   รู้ปลายทางที่ ID          => ล้างคำสั่งที่ fetch ผิดทาง 1 คำสั่ง (penalty 1 cycle)
 *      beq เทียบ register ที่ ID     => ถ้า taken ล้าง 1 คำสั่ง (penalty 1 cycle), not taken ไม่เสียรอบ
 *    การล้าง (flush) เป็นฮาร์ดแวร์อัตโนมัติ ผู้เล่นไม่ต้องกดอะไร แต่ถูกนับเป็นรอบที่เสียไป
 *  - Data Hazard ของ branch (สไลด์หน้า 62-64): beq ต้องใช้ค่าตั้งแต่ ID ซึ่งเร็วกว่า EX 1 stage
 *      producer เป็น ALU ที่อยู่ก่อนหน้า 2 คำสั่งขึ้นไป  => forward EX/MEM -> ID ได้ ไม่ต้อง stall
 *      producer เป็น ALU ที่อยู่ติดกัน หรือ lw ห่าง 2      => stall 1 รอบ แม้เปิด forwarding
 *      producer เป็น lw ที่อยู่ติดกัน                    => stall 2 รอบ แม้เปิด forwarding
 *  - "j <ตัวเอง>" (เช่น  end: j end) ถือเป็นจุดจบโปรแกรม (HALT) ไม่วนไม่รู้จบ
 * ===================================================================== */
(function (root) {
  'use strict';

  const STAGES = ['IF', 'ID', 'EX', 'MEM', 'WB'];
  const ZERO = 'zero';
  // คำอธิบายแบบสั้นสำหรับ UI หน้าเรียนรู้ก่อนเริ่มเกม
  const PIPELINE_STAGE_GUIDE = Object.freeze({
    IF: 'Instruction Fetch: หยิบคำสั่งถัดไป',
    ID: 'Instruction Decode: อ่านว่าคำสั่งสั่งอะไร',
    EX: 'Execute: คำนวณหรือเปรียบเทียบ',
    MEM: 'Memory: อ่านหรือเขียนหน่วยความจำ',
    WB: 'Write Back: บันทึกผลกลับ Register',
  });

  /* -------------------------------------------------------------------
   * 1) Decode: แปลงข้อความ assembly -> โครงสร้างที่ simulator ใช้
   *    reads / writes ถูก "คำนวณจาก assembly" (ไม่พึ่งฟิลด์ในไฟล์) เพื่อกันข้อมูลไม่ตรงกัน
   * ------------------------------------------------------------------- */
  function decodeInstruction(raw, index, labelToId) {
    const m = raw.assembly.trim().match(/^(\w+)\s*(.*)$/);
    if (!m) throw new Error('อ่านคำสั่งไม่ได้: ' + raw.assembly);
    const op = m[1].toLowerCase();
    const args = m[2] ? m[2].split(',').map((s) => s.trim()) : [];
    const R = (s) => s.replace(/^\$/, '');

    const ins = {
      id: raw.id, index, op, assembly: raw.assembly, label: raw.label || null,
      rs: null, rt: null, rd: null, imm: 0,
      reads: [], writes: [],
      isLoad: false, isStore: false, isBranch: false, isJump: false,
      target: null, targetIndex: null,
    };
    let labelName = null;

    switch (op) {
      case 'add': case 'sub': case 'mul':          // op rd, rs, rt
        ins.rd = R(args[0]); ins.rs = R(args[1]); ins.rt = R(args[2]);
        ins.reads = [ins.rs, ins.rt]; ins.writes = [ins.rd]; break;
      case 'addi':                                 // addi rt, rs, imm
        ins.rt = R(args[0]); ins.rs = R(args[1]); ins.imm = parseInt(args[2], 10);
        ins.reads = [ins.rs]; ins.writes = [ins.rt]; break;
      case 'lw': case 'sw': {                      // lw/sw rt, imm(rs)
        const mm = args[1].match(/^(-?\d+)\(\$(\w+)\)$/);
        if (!mm) throw new Error('รูปแบบ address ผิด: ' + raw.assembly);
        ins.rt = R(args[0]); ins.imm = parseInt(mm[1], 10); ins.rs = mm[2];
        if (op === 'lw') { ins.isLoad = true; ins.reads = [ins.rs]; ins.writes = [ins.rt]; }
        else { ins.isStore = true; ins.reads = [ins.rs, ins.rt]; ins.writes = []; }
        break;
      }
      case 'beq':                                  // beq rs, rt, label
        ins.rs = R(args[0]); ins.rt = R(args[1]); labelName = args[2];
        ins.isBranch = true; ins.reads = [ins.rs, ins.rt]; break;
      case 'j':                                    // j label
        labelName = args[0]; ins.isJump = true; break;
      case 'div':                                  // div rs, rt  -> LO, HI
        ins.rs = R(args[0]); ins.rt = R(args[1]);
        ins.reads = [ins.rs, ins.rt]; ins.writes = ['LO', 'HI']; break;
      case 'mflo':                                 // mflo rd
        ins.rd = R(args[0]); ins.reads = ['LO']; ins.writes = [ins.rd]; break;
      default:
        throw new Error('ยังไม่รองรับคำสั่ง: ' + op);
    }

    if (ins.isBranch || ins.isJump) {
      ins.target = raw.target != null ? raw.target : labelToId[labelName];
      if (ins.target == null) throw new Error('หา target ไม่เจอ: ' + raw.assembly);
    }
    return ins;
  }

  /* -------------------------------------------------------------------
   * 2) PipelineSimulator
   * ------------------------------------------------------------------- */
  class PipelineSimulator {
    /**
     * @param {Array}  program  อาร์เรย์ของ { id, assembly, label?, target? }
     * @param {Object} options
     *   forwarding    : เริ่มต้นเปิดสายลัดหรือไม่ (default false)
     *   autoInterlock : true = ฮาร์ดแวร์ stall ให้เองเมื่อเจอ Hazard (ไว้ทดสอบ/โหมดสอน)
     *                   false = ผู้เล่นต้องแก้เอง ไม่งั้นข้อมูลผิด (default)
     *   maxCycles     : กันวนไม่รู้จบเมื่อข้อมูลเพี้ยน (default 5000)
     *   sp            : ค่าเริ่มต้นของ $sp
     */
    constructor(program, options = {}) {
      this.opts = {
        forwarding: !!options.forwarding,
        autoInterlock: !!options.autoInterlock,
        maxCycles: options.maxCycles != null ? options.maxCycles : 5000,
        sp: options.sp != null ? options.sp : 0x7fffeffc,
      };

      const labelToId = {};
      const idToIndex = {};
      program.forEach((p, i) => {
        if (idToIndex[p.id] !== undefined) throw new Error('id ซ้ำ: ' + p.id);
        idToIndex[p.id] = i;
        if (p.label) labelToId[p.label] = p.id;
      });
      this.program = program.map((p, i) => decodeInstruction(p, i, labelToId));
      this.program.forEach((ins) => {
        if (ins.target != null) {
          if (idToIndex[ins.target] === undefined) throw new Error('target ไม่มีในโปรแกรม: ' + ins.assembly);
          ins.targetIndex = idToIndex[ins.target];
        }
      });
      this.reset();
    }

    /* ---------- สถานะเริ่มต้น ---------- */
    reset() {
      this.cycle = 0;              // จำนวน clock ที่ผ่านไป (state ปัจจุบัน = cycle นี้)
      this.pc = 0;                 // index ของคำสั่งถัดไปที่จะ fetch
      this.uidSeq = 0;
      this.regs = {};                                   // ทุก reg ที่โปรแกรมใช้เริ่มที่ 0 (UI จะได้มีครบ)
      this.program.forEach((i) => i.reads.concat(i.writes).forEach((r) => (this.regs[r] = 0)));
      this.regs.sp = this.opts.sp; this.regs.LO = 0; this.regs.HI = 0;
      this.mem = new Map();
      this.forwarding = this.opts.forwarding;
      this.autoInterlock = this.opts.autoInterlock;
      this.stallRequests = 0;      // จำนวน NOP ที่ผู้เล่นสั่งไว้ (ใช้ทีละ 1 ต่อ clock)
      this.fetchStopped = false;   // true หลังเจอ HALT
      this.halted = false;
      this.timedOut = false;
      this.pipe = {};
      STAGES.forEach((s) => (this.pipe[s] = this._bubble('EMPTY')));
      this.stats = {
        cycles: 0, retired: 0,
        stalls: 0, wastedStalls: 0,   // wasted = ผู้เล่นสั่ง stall ทั้งที่ไม่มี Hazard
        flushed: 0,                    // จำนวนคำสั่งที่ถูกล้างจาก Control Hazard
        forwards: 0,                   // จำนวนครั้งที่สายลัดทำงานจริง
        staleReads: 0,                 // จำนวนครั้งที่อ่านค่าเก่า (Hazard ที่ไม่ได้แก้)
      };
      this.eventLog = [];
      this.timeline = [];
      this._record();
    }

    /* ---------- ตัวช่วยสร้างคำสั่ง / bubble ---------- */
    _inst(ins) {
      return { uid: ++this.uidSeq, bubble: false, ins, operands: {}, results: {},
        taken: null, addr: null, storeValue: null, corrupted: false, flushed: false };
    }
    // kind: 'EMPTY' (ว่าง) | 'STALL' (NOP ที่ผู้เล่น/ฮาร์ดแวร์แทรก) | 'FLUSH' (ถูกล้างจาก Control Hazard)
    _bubble(kind, ghost) {
      return { uid: ++this.uidSeq, bubble: true, kind, ins: null, results: {}, ghost: ghost || null };
    }
    // ล้างคำสั่งผิดทาง: ของจริง -> กลายเป็น bubble FLUSH, ถ้าเป็น bubble อยู่แล้วปล่อยผ่าน
    _squash(inst, events) {
      if (inst.bubble) return inst;
      inst.flushed = true;
      this.stats.flushed++;
      events.push({ type: 'FLUSH', cycle: this.cycle, instruction: brief(inst) });
      return this._bubble('FLUSH', inst.ins);
    }

    /* =================================================================
     * checkHazard(): ตรวจ state "ปัจจุบัน" (ยังไม่ขยับ clock)
     *   - Data Hazard (RAW): คำสั่งใน ID ต้องการ reg ที่ producer ใน EX หรือ MEM ยังเขียนไม่เสร็จ
     *   - Control Hazard   : คำสั่งใน ID เป็น j / beq
     * ================================================================= */
    checkHazard() {
      const id = this.pipe.ID;
      const report = { cycle: this.cycle, data: [], control: null,
        stallsNeeded: 0, stallsWithForwarding: 0, needsAction: false, hasHazard: false };
      if (id.bubble) return report;
      const isBranch = id.ins.isBranch;              // beq ใช้ค่าตั้งแต่ ID ไม่ใช่ EX

      for (const reg of new Set(id.ins.reads)) {      // Set: add $t1,$t0,$t0 นับ $t0 ครั้งเดียว
        if (reg === ZERO) continue;
        // หา producer ที่ "ใหม่ที่สุด" ก่อน: EX แล้วค่อย MEM (WB ไม่ชน เพราะเขียนครึ่งแรก)
        let producer = null, stage = null;
        for (const s of ['EX', 'MEM']) {
          const cand = this.pipe[s];
          if (!cand.bubble && cand.ins.writes.includes(reg)) { producer = cand; stage = s; break; }
        }
        if (!producer) continue;

        const isLoad = producer.ins.isLoad;
        // จำนวน stall เมื่อเปิดสายลัด
        //  - ALU/lw ปกติ: สายลัดเข้า EX  -> ติดแค่ Load-Use (lw อยู่ EX) 1 รอบ
        //  - beq: สายลัด EX/MEM -> ID ได้เฉพาะผลของ ALU ที่อยู่ MEM แล้ว (สไลด์หน้า 62-64)
        let withFwd;
        if (isBranch) withFwd = stage === 'EX' ? (isLoad ? 2 : 1) : (isLoad ? 1 : 0);
        else withFwd = stage === 'EX' && isLoad ? 1 : 0;
        const withoutFwd = stage === 'EX' ? 2 : 1;           // ไม่มีสายลัด: ต้องรอจน producer ถึง WB
        const stallsNeeded = this.forwarding ? withFwd : withoutFwd;
        const loadUse = isLoad && withFwd > 0;
        const fixedByForwarding = this.forwarding && withFwd === 0;

        const kind = isBranch ? (loadUse ? 'Branch + Load-Use: ' : 'Branch: ') : loadUse ? 'Load-Use: ' : 'RAW: ';
        report.data.push({
          type: 'RAW', reg, producerStage: stage, loadUse, branchCompare: isBranch,
          producer: brief(producer), consumer: brief(id),
          resolvedByForwarding: fixedByForwarding, stallsNeeded, stallsWithForwarding: withFwd,
          message: kind + '$' + reg + ' จาก "' + producer.ins.assembly + '" (อยู่ที่ ' + stage + ') ยังเขียนไม่เสร็จ' +
            (isBranch ? ' — beq เทียบค่าที่ ID' : ''),
        });
        report.stallsNeeded = Math.max(report.stallsNeeded, stallsNeeded);
        report.stallsWithForwarding = Math.max(report.stallsWithForwarding, withFwd);
      }

      if (id.ins.isJump || isBranch) {
        report.control = {
          type: 'CONTROL', kind: id.ins.isJump ? 'JUMP' : 'BRANCH',
          instruction: brief(id),
          resolveStage: 'ID',
          penaltyCycles: 1,                           // beq: จ่ายก็ต่อเมื่อ taken (Predict Not Taken)
          certain: id.ins.isJump,                     // j แน่นอนว่ากระโดด, beq รู้ผลเมื่อเทียบ register ที่ ID
          message: id.ins.isJump
            ? 'Control: "' + id.ins.assembly + '" กระโดดเสมอ คำสั่งที่ fetch ไว้ผิดทางจะถูกล้าง (เสีย 1 รอบ)'
            : 'Control: "' + id.ins.assembly + '" เดาว่าไม่กระโดด (Predict Not Taken) ถ้า taken จะล้างคำสั่งผิดทาง 1 คำสั่ง (เสีย 1 รอบ)',
        };
      }

      report.needsAction = report.stallsNeeded > 0;
      report.hasHazard = report.data.length > 0 || report.control !== null;
      return report;
    }

    /* =================================================================
     * ปุ่มของผู้เล่น
     * ================================================================= */

    /** แทรก NOP 1 ตัว: clock ถัดไป คำสั่งใน ID + IF จะค้างอยู่ที่เดิม (PC ไม่ขยับ)
     *  และมี bubble (NOP) ไหลเข้า EX แทน — นี่คือ pipeline stall มาตรฐาน */
    insertStall() {
      this.stallRequests++;
      const r = this.checkHazard();
      return { ok: true, queued: this.stallRequests, useful: r.stallsNeeded > 0, report: r };
    }

    /** เปิดสายลัด EX/MEM และ MEM/WB -> อินพุตของ EX (และ EX/MEM -> ตัวเทียบของ beq ที่ ID)
     *  แก้ RAW ที่เกิดจากคำสั่ง ALU ได้ทันที แต่ Load-Use และ beq ที่ใช้ค่าจากคำสั่งติดกันยังต้อง stall */
    enableForwarding() {
      const already = this.forwarding;
      this.forwarding = true;
      const r = this.checkHazard();
      return {
        ok: true, alreadyEnabled: already,
        fixed: r.data.filter((h) => h.resolvedByForwarding),
        stillNeedsStall: r.stallsNeeded > 0, stallsNeeded: r.stallsNeeded, report: r,
      };
    }
    disableForwarding() { this.forwarding = false; return { ok: true }; }

    /* =================================================================
     * nextCycle(): เดินหน้า 1 clock
     * ลำดับงานใน clock เดียว (สำคัญ!):
     *   EX -> MEM -> WB -> ID -> IF
     *   - EX ทำก่อน MEM เพื่อให้ lw ที่ยังอยู่ MEM "ยังไม่มีข้อมูล" ให้ forward (ตรงกับฮาร์ดแวร์จริง)
     *   - WB เขียน register ก่อน ID อ่าน (เขียนครึ่งแรก / อ่านครึ่งหลัง)
     *   - j / beq ตัดสินที่ ID ถ้ากระโดดจะล้างคำสั่งใน IF 1 คำสั่ง
     * ================================================================= */
    nextCycle() {
      if (this.status() !== 'RUNNING') return this._result([]);

      const cur = this.pipe;
      const events = [];
      const report = this.checkHazard();

      // --- ตัดสินใจว่า clock นี้จะ stall ไหม (ผู้เล่นสั่ง หรือโหมด autoInterlock) ---
      let stall = false, stallSource = null;
      if (this.stallRequests > 0) { this.stallRequests--; stall = true; stallSource = 'PLAYER'; }
      else if (this.autoInterlock && report.stallsNeeded > 0) { stall = true; stallSource = 'AUTO'; }

      // --- EX: เลือก operand (forward ถ้าเปิดสายลัด) แล้วคำนวณ ---
      if (!cur.EX.bubble) this._execute(cur.EX, cur, events);
      // --- MEM / WB ---
      if (!cur.MEM.bubble) this._memory(cur.MEM);
      if (!cur.WB.bubble) this._writeBack(cur.WB);

      // --- ID: อ่าน register file (เฉพาะเมื่อคำสั่งเดินต่อ) + ตัดสิน j / beq ---
      let redirect = null;
      if (!stall && !cur.ID.bubble) {
        const id = cur.ID;
        for (const r of id.ins.reads) id.operands[r] = r === ZERO ? 0 : (this.regs[r] || 0);
        if (id.ins.isBranch) {
          this._resolveBranch(id, cur, events);
          if (id.taken) redirect = id.ins.targetIndex;
        } else if (id.ins.isJump) {
          id.taken = true;
          redirect = id.ins.targetIndex;
          if (id.ins.target === id.ins.id) this.fetchStopped = true;   // j ตัวเอง = HALT
        }
      }

      // --- บันทึกเหตุการณ์ stall ---
      if (stall) {
        const useful = report.stallsNeeded > 0;
        this.stats.stalls++;
        if (!useful) this.stats.wastedStalls++;
        events.push({ type: 'STALL', cycle: this.cycle, source: stallSource, useful });
      }
      if (redirect !== null) {
        events.push({ type: 'CONTROL_HAZARD', cycle: this.cycle, kind: report.control.kind,
          instruction: report.control.instruction, penalty: 1 });
      }

      // --- เลื่อน pipeline ---
      const next = { WB: cur.MEM, MEM: cur.EX };
      if (stall) {
        next.EX = this._bubble('STALL');
        next.ID = cur.ID;           // ค้างไว้
        next.IF = cur.IF;           // ค้างไว้ (PC ไม่ขยับ)
      } else {
        next.EX = cur.ID;
        if (redirect !== null) {    // j / beq taken: ล้างคำสั่งที่ fetch ผิดทางใน IF (penalty 1)
          next.ID = this._squash(cur.IF, events);
          this.pc = redirect;
        } else {
          next.ID = cur.IF;
        }
        next.IF = this._fetch();
      }

      this.pipe = next;
      this.cycle++;
      this.stats.cycles = this.cycle;

      // HALT: เมื่อ "j end" เข้าถึง WB ถือว่าจบ (ไม่มีอะไรให้เขียนกลับ)
      const wb = next.WB;
      if (!wb.bubble && wb.ins.isJump && wb.ins.target === wb.ins.id) {
        this._writeBack(wb);
        this.halted = true;
      }
      if (!this.halted && this.cycle >= this.opts.maxCycles) this.timedOut = true;

      this.eventLog.push(...events);
      this._record();
      return this._result(events);
    }

    /* ---------- IF ---------- */
    _fetch() {
      if (this.fetchStopped || this.pc < 0 || this.pc >= this.program.length) return this._bubble('EMPTY');
      return this._inst(this.program[this.pc++]);
    }

    /* ---------- EX ---------- */
    _execute(inst, cur, events) {
      const ins = inst.ins;
      if (ins.isBranch || ins.isJump) return;    // ตัดสินไปแล้วที่ ID
      const v = {};                              // ค่า operand ที่ใช้จริง
      for (const reg of ins.reads) {
        if (reg === ZERO) { v[reg] = 0; continue; }
        let value = inst.operands[reg];          // ค่าที่อ่านไว้ตอน ID (อาจเก่า!)
        // producer ที่ยังไม่ commit ลง register file = อยู่ MEM หรือ WB ในตอนนี้
        // (ถ้ามี แปลว่าตอน ID เราอ่านค่าเก่ามา — ใหม่ที่สุดต้องมาก่อน)
        const prod = this._findProducer(reg, [cur.MEM, cur.WB]);
        if (prod) {
          const ready = prod.results[reg] !== undefined;     // lw ที่ยังอยู่ MEM -> ยังไม่พร้อม
          if (this.forwarding && ready) {
            value = prod.results[reg];
            this.stats.forwards++;
            events.push({ type: 'FORWARD', cycle: this.cycle, reg,
              path: prod === cur.MEM ? 'EX/MEM' : 'MEM/WB', dest: 'EX',
              from: brief(prod), to: brief(inst) });
          } else {
            inst.corrupted = true;
            this.stats.staleReads++;
            events.push({ type: 'STALE_READ', cycle: this.cycle, reg,
              reason: this.forwarding ? 'LOAD_USE' : 'NO_FORWARDING',
              instruction: brief(inst), producer: brief(prod) });
          }
        }
        v[reg] = value;
      }

      switch (ins.op) {
        case 'add':  inst.results[ins.rd] = (v[ins.rs] + v[ins.rt]) | 0; break;
        case 'sub':  inst.results[ins.rd] = (v[ins.rs] - v[ins.rt]) | 0; break;
        case 'mul':  inst.results[ins.rd] = Math.imul(v[ins.rs], v[ins.rt]); break;
        case 'addi': inst.results[ins.rt] = (v[ins.rs] + ins.imm) | 0; break;
        case 'div':
          if (v[ins.rt] === 0) { inst.results.LO = 0; inst.results.HI = 0; }   // MIPS: ไม่นิยาม
          else { inst.results.LO = (v[ins.rs] / v[ins.rt]) | 0; inst.results.HI = v[ins.rs] % v[ins.rt]; }
          break;
        case 'mflo': inst.results[ins.rd] = v.LO; break;
        case 'lw':   inst.addr = (v[ins.rs] + ins.imm) | 0; break;           // ข้อมูลมาตอน MEM
        case 'sw':   inst.addr = (v[ins.rs] + ins.imm) | 0; inst.storeValue = v[ins.rt]; break;
      }
    }

    /* ---------- ID: ตัวเทียบของ beq ----------
     * เรียกหลัง EX/MEM/WB ของ clock นี้ทำงานแล้ว แต่ในฮาร์ดแวร์จริงผลที่ ID ใช้ได้มีแค่
     *  - register file (WB เขียนครึ่งแรกไปแล้ว)
     *  - สายลัด EX/MEM -> ID: ผลของ ALU ที่คำนวณเสร็จตั้งแต่ clock ก่อน (ตอนนี้อยู่ MEM)
     * ผลของคำสั่งที่อยู่ EX ตอนนี้ หรือ lw ที่กำลังอ่าน memory ยังมาไม่ทัน */
    _resolveBranch(inst, cur, events) {
      const ins = inst.ins;
      const v = {};
      for (const reg of ins.reads) {
        if (reg === ZERO) { v[reg] = 0; continue; }
        let value = inst.operands[reg];
        const prod = this._findProducer(reg, [cur.EX, cur.MEM]);
        if (prod) {
          if (this.forwarding && prod === cur.MEM && !prod.ins.isLoad) {
            value = prod.results[reg];
            this.stats.forwards++;
            events.push({ type: 'FORWARD', cycle: this.cycle, reg, path: 'EX/MEM', dest: 'ID',
              from: brief(prod), to: brief(inst) });
          } else {
            inst.corrupted = true;
            this.stats.staleReads++;
            events.push({ type: 'STALE_READ', cycle: this.cycle, reg,
              reason: !this.forwarding ? 'NO_FORWARDING' : prod.ins.isLoad ? 'LOAD_USE' : 'BRANCH_IN_ID',
              instruction: brief(inst), producer: brief(prod) });
          }
        }
        v[reg] = value;
      }
      inst.taken = v[ins.rs] === v[ins.rt];
    }

    _findProducer(reg, stageInsts) {
      for (const s of stageInsts) if (!s.bubble && s.ins.writes.includes(reg)) return s;
      return null;
    }

    /* ---------- MEM ---------- */
    _memory(inst) {
      if (inst.ins.isLoad) inst.results[inst.ins.rt] = this.mem.has(inst.addr) ? this.mem.get(inst.addr) : 0;
      else if (inst.ins.isStore) this.mem.set(inst.addr, inst.storeValue);
    }

    /* ---------- WB ---------- */
    _writeBack(inst) {
      for (const [reg, val] of Object.entries(inst.results)) if (reg !== ZERO) this.regs[reg] = val;
      this.stats.retired++;
    }

    /* =================================================================
     * Snapshot สำหรับ UI
     * ================================================================= */
    status() { return this.halted ? 'FINISHED' : this.timedOut ? 'TIMEOUT' : 'RUNNING'; }

    getState() {
      const pipeline = {};
      STAGES.forEach((s) => (pipeline[s] = view(this.pipe[s])));
      const st = this.stats;
      return {
        cycle: this.cycle, status: this.status(), forwarding: this.forwarding,
        pendingStalls: this.stallRequests,
        // คำสั่งที่กำลังจะถูก fetch ใน clock ถัดไป (null = หยุด fetch แล้ว / หมดโปรแกรม)
        nextFetchId: !this.fetchStopped && this.program[this.pc] ? this.program[this.pc].id : null,
        pipeline, regs: { ...this.regs },
        stats: { ...st, cpi: st.retired ? +(st.cycles / st.retired).toFixed(2) : null },
        hazard: this.checkHazard(),
      };
    }

    _result(events) { return { cycle: this.cycle, status: this.status(), events, state: this.getState() }; }

    // ตารางไทม์ไลน์สำหรับวาด Pipeline Diagram: timeline[k] = ของ cycle k
    _record() {
      const cell = (i) => (i.bubble ? (i.kind === 'STALL' ? 'stall' : i.kind === 'FLUSH' ? 'flush' : null) : i.ins.id);
      const row = { cycle: this.cycle };
      STAGES.forEach((s) => (row[s] = cell(this.pipe[s])));
      this.timeline.push(row);
    }

    /** เรียกซ้ำจนจบ (ใช้ทดสอบ / ปุ่ม "Auto run") */
    run(maxSteps = Infinity) {
      let n = 0;
      while (this.status() === 'RUNNING' && n++ < maxSteps) this.nextCycle();
      return this.getState();
    }

    /** เทียบ register กับค่าที่คาดหวัง เช่น nCrExpected */
    verify(expected) {
      const diffs = [];
      for (const [reg, want] of Object.entries(expected)) {
        const got = this.regs[reg] || 0;
        if (got !== want) diffs.push({ reg, want, got });
      }
      return { ok: diffs.length === 0, diffs };
    }
  }

  /* ---------- helper: ข้อมูลย่อของคำสั่ง ---------- */
  function brief(inst) { return inst.bubble ? null : { uid: inst.uid, id: inst.ins.id, assembly: inst.ins.assembly }; }
  function view(inst) {
    if (inst.bubble) {
      return { bubble: true, uid: inst.uid, kind: inst.kind, id: null,
        assembly: inst.kind === 'STALL' ? 'NOP (stall)' : inst.kind === 'FLUSH' ? 'NOP (flushed)' : '—',
        ghost: inst.ghost ? inst.ghost.assembly : null };   // ghost = คำสั่งที่ถูกล้าง (ไว้ทำเอฟเฟกต์)
    }
    return { bubble: false, uid: inst.uid, id: inst.ins.id, assembly: inst.ins.assembly,
      isBranch: inst.ins.isBranch, corrupted: inst.corrupted };
  }

  const api = { PipelineSimulator, decodeInstruction, STAGES, PIPELINE_STAGE_GUIDE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
