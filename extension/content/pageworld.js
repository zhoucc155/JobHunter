// ============================================================
// pageworld.js — 以 MAIN world 运行的图片注入脚本（与 BOSS 的 Vue 同源 realm）
// 关键背景（2026-07-29）：
//   content script 默认运行在 isolated world，其中 new DataTransfer()/new File() 创建的对象
//   与页面脚本（Vue）分属不同 realm，直接给 input.files 赋值时 Vue 读不到文件（赋值静默失效），
//   表现为「图片既发不出、也不在输入框出现草稿」。
//   通过 manifest 声明 world:"MAIN" 让本脚本在页面主世界执行，与 Vue 同一 realm，
//   File/DataTransfer 对象能被 Vue 的上传处理器正常读取；且 main world 内容脚本不受页面 CSP 限制，
//   规避了「内联 <script> 注入被 CSP 拦截」的坑（此前失败的根因）。
// 对外暴露 window.__jhPageWorld.injectResumeImage(dataUrl, fileName)。
// ============================================================
(function () {
  if (window.__jhPageWorld) return;

  window.__jhPageWorld = {
    /**
     * 把 dataURL 转成 File，注入到聊天主区的「发图片」file input，并派发 change/input 事件。
     * 返回 { ok:true } 或 { ok:false, reason }。
     * 定位优先级：① 聊天主区 .chat-conversation 内的 file input（=发图片按钮，排除上传简历弹窗）；
     *            ② 退而求其次，全局第一个不在 .upload-resume-dialog 内的 file input。
     */
    injectResumeImage: function (dataUrl, fileName) {
      try {
        if (!dataUrl || !dataUrl.startsWith('data:')) {
          return { ok: false, reason: 'empty-or-bad-dataUrl' };
        }

        // 定位「发图片」file input（诊断 v4 实测：file#0 = .chat-conversation 内 .btn-sendimg > input）
        var input = document.querySelector('.chat-conversation input[type="file"]');
        if (!input) {
          var all = Array.prototype.slice
            .call(document.querySelectorAll('input[type="file"]'))
            .filter(function (el) { return !(el.closest && el.closest('.upload-resume-dialog')); });
          input = all[0] || null;
        }
        if (!input) return { ok: false, reason: 'no-file-input' };

        // dataURL → 二进制 → File（全部在 main world 创建，与 Vue 同 realm）
        var arr = dataUrl.split(',');
        var mimeMatch = arr[0].match(/:(.*?);/);
        var mime = mimeMatch ? mimeMatch[1] : 'image/png';
        var bin = atob(arr[1]);
        var u8 = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        var file = new File([u8], fileName || 'resume.png', { type: mime });

        var dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files; // 同 realm 赋值，Vue 上传处理器能读到
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        // 补一次 drop 事件（部分上传组件监听拖拽）
        try {
          var drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
          input.dispatchEvent(drop);
        } catch (e) {
          try { var d2 = new Event('drop', { bubbles: true, cancelable: true }); d2.dataTransfer = dt; input.dispatchEvent(d2); } catch (e2) {}
        }
        return { ok: true, filesSet: input.files ? input.files.length : 0, inputClass: (input.className || '') };
      } catch (err) {
        return { ok: false, reason: String((err && err.message) ? err.message : err), inputClass: '' };
      }
    }
  };

  // 通知 content script 已就绪（便于投递时无需长轮询）
  try { window.dispatchEvent(new CustomEvent('jh-pageworld-ready')); } catch (e) {}
})();
