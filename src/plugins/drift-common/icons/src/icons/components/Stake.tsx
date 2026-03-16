import * as React from 'react';
import { IconProps } from '../../types';
import { IconWrapper } from '../IconWrapper';

const Stake = (allProps: IconProps) => {
	const { svgProps: props, ...restProps } = allProps;
	return (
		<IconWrapper
			icon={
				<svg
					viewBox="0 0 24 24"
					fill="none"
					xmlns="http://www.w3.org/2000/svg"
					{...props}
				>
					<path
						fillRule="evenodd"
						clipRule="evenodd"
						d="M4.5 4.5v13h15v-13h-15zM4.4 3A1.4 1.4 0 003 4.4v13.2A1.4 1.4 0 004.4 19h2.85v1a.75.75 0 001.5 0v-1h6.5v1a.75.75 0 001.5 0v-1h2.85a1.4 1.4 0 001.4-1.4V4.4A1.4 1.4 0 0019.6 3H4.4zm3.35 5.5a.75.75 0 00-1.5 0v5a.75.75 0 001.5 0v-5zM16.5 11a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0zm1.5 0a3 3 0 11-6 0 3 3 0 016 0z"
						fill={allProps.color ? allProps.color : 'currentColor'}
					/>
				</svg>
			}
			{...restProps}
		/>
	);
};
export default Stake;
