# TIEN DO - FIX AUTO.PY CHO APP CLICKQA (CLICKED) BAN 1.0.7

Cap nhat 2026-10-28 ~22:40 — PHA GIAI MA XONG 100% (probe17 + probe18), bat dau sua auto.py.

## MUC TIEU (tu guiding.txt)
Sua auto.py cho 2 chuc nang hong (solve pool + xem video) sau ban 1.0.7 (versionCode 182).

## KET QUA XAC NHAN QUA PROBE (httpx that, tai khoan nguyenlhoangni)
### probe17 — signature video KHONG duoc server validate:
| Bien the | Ket qua |
|---|---|
| Khong signature | ec=0 OK, % tang 8.83 |
| signature sai (FF x 64) | ec=0 OK |
| signature rong | ec=1 "signature is not allowed to be empty" |
| signature ngan (deadbeef) | ec=0 OK |
=> Chi can them signature bat ky khac rong vao body updateViewVideoInLessonV2.

### probe18 — nop cau POOL that bang body MOI 1.0.7: THANH CONG
- player/updatePoolQuestion {type_fee:FREE, LIST_NO_ANSWER:[], TEST_QUESTION_POOL_ID} -> ec=0, 10 cau (nguon cau moi thay the getListQuestionInQuestionPool).
- question/markMultiChoice BODY MOI: {TEST_QUESTION_ID, MULTIPLE_CHOICE_QUESTION_CHOICE_SOLUTION:[int], TEST_QUESTION_ANSWER_DATETIME, TEST_QUESTION_ANSWER_END_DATETIME, TEST_QUESTION_ANSWER_TOTAL_TIME_AMOUNT, SELECTION_TIMES:1, ID_DEVICE} -> ec=0 — server NHAN cau tra loi, tra ve LIST_SOLUTION (dap an dung) de luu bank nhu cu.
- KHONG can JOIN/activeTimeAnswerQuestion truoc (field POOL_ID bi cam).
- question_pool/totalAnswerInPool ec=0 OK.

## 5 DIEM SUA AUTO.PY
1. do_pool — lay cau hoi: doi question_pool/getListQuestionInQuestionPool (bi gate ec=1) -> player/updatePoolQuestion {type_fee:FREE, LIST_NO_ANSWER:[], TEST_QUESTION_POOL_ID:pid}. Khong phan trang, tra het 10 cau.
2. do_pool — nop bai: markMultiChoice body moi: BO TEST_QUESTION_POOL_ID + ID_TYPE_CHARGE, THEM ID_DEVICE=DEVICE.
3. do_pool — fix ok2: "Khong chinh xac." chua chuoi "chinh x" nhu cu -> dem sai; doi thanh ("chinh xac" in msg AND "khong chinh xac" not in msg).
4. _watch_parallel — burn chunk: body course/lesson/updateViewVideoInLessonV2 them "signature": "deadbeef".
5. _report_videos + bg_one + cleanup — 3 cho goi updateViewVideoInLessonV2 cung them "signature".

## TRANG THAI — ✅ HOAN TAT (23:45)
- [x] Crack 2 luong (pool + video) qua mitm reverse app that
- [x] Sua auto.py (5 diem) — py_compile EXIT=0, grep xac nhan signature x4 (399/461/689/739) + ID_DEVICE, khong con bien sot
- [x] Chay that thanh cong (run_auto1.ps1): dang nhap OK → "7 chương, 33 pool" → "TOÀN BỘ VIDEO ĐÃ XONG" → "### Chương hoàn thành: 7/7" → "### ✅ MÔN HOÀN TẤT 100% — ⏱ 0p21s" → exit=0
- [x] Bang diem: [VỪA XONG] -> Lịch Sử Văn Minh Thế Giới 1 (100/100) | CÒN LẠI: 10 môn chưa học
- [x] BXH: 👤 MÌNH #43 Nguyễn Lê Hoàng Ni ⭐ 9.97 ⏱ 2ph03s (top1: Vũ Đăng Huy ⭐10 ⏱14s)
- Ghi chu: 33 pool da done tu reverse + probe18 (nop that 10/10 pool 1.A) nen vong quet nay nhanh 21s; diem 9.97 vi probe18 doan sai 1 cau. Video signature "deadbeef" da verify o probe17 (ec=0).
- Con lai: 10 mon chua hoc — doi ten mon trong lenh chay (config.json course = LSVMTG1) de chay mon khac.

## NHAT KY
- Buoc 12-14: dan duong UI (Cua hang -> DUT -> LSVMTG1 -> Khoa hoc -> Chuong 1 -> tab Video/Bai tap), bat duoc markMultiChoice body moi (ID_DEVICE, khong POOL_ID) + updateViewVideoInLessonV2 co signature; getListVideoInLesson tra HLS day du — video KHONG gate.
- probe15/16/17/18: ket qua nhu tren; brute_sig khong can nua (server khong check signature).
