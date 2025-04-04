'use client'

import { forwardRef } from 'react';
import styles from './page.module.css';

export const LocalVideo = forwardRef<HTMLVideoElement>((props, ref) => (
    <video
        ref={ref}
        autoPlay
        muted
        className={styles.localVideo}
        {...props}
    />
));

export const RemoteVideo = forwardRef<HTMLVideoElement>((props, ref) => (
    <video
        ref={ref}
        autoPlay
        className={styles.remoteVideo}
        {...props}
    />
));